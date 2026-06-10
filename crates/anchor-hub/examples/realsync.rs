#[tokio::main]
async fn main() {
    let host = std::env::var("OLLAMA_HOST").unwrap_or_else(|_| "http://localhost:11434".into());
    let models = anchor_hub::ollama::list_local_models(&host).await.expect("list failed");
    println!("list_local_models returned {} models:", models.len());
    for m in &models {
        let d = anchor_hub::ollama::show_details(&host, &m.id).await;
        println!("  id={:?} family={:?} size={:?} param={:?} quant={:?} show={:?}",
            m.id, m.family, m.size_bytes, m.parameter_size, m.quantization, d);
    }
}
