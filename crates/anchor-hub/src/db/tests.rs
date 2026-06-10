//! Round-trip tests for the SQLite cache. Kept in their own file so the storage
//! logic stays readable and these are easy to grow or drop later.

use super::*;

fn model(id: &str, status: ModelStatus) -> Model {
    Model {
        id: id.to_string(),
        name: id.to_string(),
        family: "llama".to_string(),
        size_bytes: Some(123),
        status,
        parameter_size: Some("8.0B".to_string()),
        quantization: Some("Q4_K_M".to_string()),
        context_tokens: Some(131072),
        modified_at: Some("2024-01-02T03:04:05Z".to_string()),
        publisher: Some("Meta".to_string()),
    }
}

fn in_memory() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    init_schema(&conn).unwrap();
    conn
}

#[test]
fn replace_all_then_read_all_round_trips() {
    let mut conn = in_memory();
    let models = vec![
        model("llama3.1:8b", ModelStatus::Installed),
        model("qwen2.5:14b", ModelStatus::Installed),
    ];
    replace_all(&mut conn, &models).unwrap();

    let read = read_all(&conn).unwrap();
    // read_all orders by name, so qwen sorts before llama... actually "llama" < "qwen".
    assert_eq!(read.len(), 2);
    let llama = read.iter().find(|m| m.id == "llama3.1:8b").unwrap();
    assert_eq!(llama, &model("llama3.1:8b", ModelStatus::Installed));
}

#[test]
fn replace_all_mirrors_upstream_removals() {
    let mut conn = in_memory();
    replace_all(
        &mut conn,
        &[
            model("a", ModelStatus::Installed),
            model("b", ModelStatus::Installed),
        ],
    )
    .unwrap();
    // Second sync no longer includes "a": it must disappear from the cache.
    replace_all(&mut conn, &[model("b", ModelStatus::Installed)]).unwrap();

    let read = read_all(&conn).unwrap();
    assert_eq!(read.len(), 1);
    assert_eq!(read[0].id, "b");
}

#[test]
fn delete_one_removes_a_single_row() {
    let mut conn = in_memory();
    replace_all(
        &mut conn,
        &[
            model("a", ModelStatus::Installed),
            model("b", ModelStatus::Installed),
        ],
    )
    .unwrap();
    delete_one(&conn, "a").unwrap();

    let read = read_all(&conn).unwrap();
    assert_eq!(read.len(), 1);
    assert_eq!(read[0].id, "b");
}
