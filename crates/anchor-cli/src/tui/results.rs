use super::*;
use ratatui::widgets::HighlightSpacing;
use std::collections::HashMap;
use std::ops::Range;

#[derive(Clone)]
pub(super) struct RunGroup {
    rows: Range<usize>,
    title: String,
}

pub(super) fn session_id(row: &Row) -> Option<&str> {
    let (id, workload) = row.id.split_once(':')?;
    // Evidence-backed rows use the session ID followed by the workload ID.
    (id.len() == 32
        && id.bytes().all(|b| b.is_ascii_hexdigit())
        && row.value["prompt_id"].as_str() == Some(workload))
    .then_some(id)
}

pub(super) fn group_workloads(rows: Vec<Row>) -> (Vec<Row>, Vec<RunGroup>) {
    let mut indices = HashMap::new();
    let mut buckets: Vec<Vec<Row>> = Vec::new();
    for row in rows {
        let key = match session_id(&row) {
            Some(id) => (id.to_owned(), None),
            None => (
                string(&row.value, "suite_id"),
                row.value["suite_version"].as_u64(),
            ),
        };
        let index = *indices.entry(key).or_insert_with(|| {
            buckets.push(Vec::new());
            buckets.len() - 1
        });
        buckets[index].push(row);
    }
    let mut rows = Vec::new();
    let mut groups = Vec::new();
    let mut run_number = 0;
    buckets.sort_by_key(|bucket| session_id(&bucket[0]).is_none());
    for mut bucket in buckets {
        let first = &bucket[0];
        let title = if session_id(first).is_some() {
            run_number += 1;
            let count = bucket.len();
            let workloads = if count == 1 { "workload" } else { "workloads" };
            let age = first.value["updated_at"]
                .as_i64()
                .map_or(String::new(), |timestamp| format!(" · {}", ago(timestamp)));
            bucket.sort_by_key(|row| {
                let id = row.value["prompt_id"].as_str();
                anchor_hub::CATALOG
                    .iter()
                    .position(|s| Some(s.id) == id)
                    .unwrap_or(anchor_hub::CATALOG.len())
            });
            format!("Run {run_number}{age} · {count} {workloads}")
        } else {
            format!(
                "Legacy · {} v{}",
                string(&first.value, "suite_id"),
                first.value["suite_version"]
            )
        };
        let start = rows.len();
        rows.append(&mut bucket);
        groups.push(RunGroup {
            rows: start..rows.len(),
            title,
        });
    }
    (rows, groups)
}

impl App {
    pub(super) fn draw_workloads(&mut self, frame: &mut ratatui::Frame, area: Rect) {
        let filtered = self.browser.filtered();
        let count = filtered.len();
        let index = self.browser.selected;
        let model = self
            .browser
            .rows
            .first()
            .map_or(String::new(), |row| format!(" · {}", row.label));
        let block = Block::default().borders(Borders::TOP).title(format!(
            " Measured workloads  {}/{}{model} ",
            if count == 0 { 0 } else { index + 1 },
            count,
        ));
        let inner = block.inner(area);
        frame.render_widget(block, area);
        if count == 0 {
            if !self.browser.query.is_empty() {
                frame.render_widget(Paragraph::new("No matches"), inner);
            }
            return;
        }

        let show_context = inner.width >= 48;
        let workload_width = if show_context {
            16
        } else {
            (inner.width as usize).saturating_sub(22).min(16)
        };
        let columns = |workload: &str, ctx: &str, decode: &str, ttft: &str| {
            if show_context {
                format!(
                    "{workload:<workload_width$.workload_width$} {ctx:>7} {decode:>11} {ttft:>8}"
                )
            } else {
                format!("{workload:<workload_width$.workload_width$} {decode:>9} {ttft:>8}")
            }
        };
        let [heading, body] =
            Layout::vertical([Constraint::Length(1), Constraint::Min(0)]).areas(inner);
        frame.render_widget(
            Paragraph::new(format!(
                "   {}",
                columns(
                    "WORKLOAD",
                    "CTX",
                    if show_context {
                        "DECODE t/s"
                    } else {
                        "DEC tok/s"
                    },
                    "TTFT ms"
                )
            ))
            .style(Style::new().add_modifier(Modifier::BOLD)),
            heading,
        );
        let mut items = Vec::new();
        let mut selectable = Vec::with_capacity(count);
        let mut group_index = 0;
        for (position, &row_index) in filtered.iter().enumerate() {
            while !self.browser.run_groups[group_index]
                .rows
                .contains(&row_index)
            {
                group_index += 1;
            }
            let group = &self.browser.run_groups[group_index];
            if body.height > 1 && (position == 0 || !group.rows.contains(&filtered[position - 1])) {
                items.push(ListItem::new(Line::from(vec![
                    Span::styled("─ ", ACCENT),
                    Span::styled(
                        group.title.as_str(),
                        Style::new().add_modifier(Modifier::BOLD),
                    ),
                ])));
            }
            selectable.push(items.len());
            let run = &self.browser.rows[row_index].value;
            items.push(ListItem::new(columns(
                &plain(run["prompt_id"].as_str().unwrap_or("Legacy")),
                &run["num_ctx"].to_string(),
                &screens::number(run, "decode_tps_median", ""),
                &screens::number(run, "ttft_ms_median", ""),
            )));
        }
        self.browser.state.select(selectable.get(index).copied());
        frame.render_stateful_widget(
            List::new(items)
                .highlight_spacing(HighlightSpacing::Always)
                .highlight_symbol(" › ")
                .highlight_style(SELECTED),
            body,
            &mut self.browser.state,
        );
        let start = self.browser.state.offset();
        let end = start + body.height as usize;
        self.page_size = (selectable.partition_point(|&row| row < end)
            - selectable.partition_point(|&row| row < start))
        .max(1);
    }
}
