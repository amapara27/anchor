use std::{
    io::{BufRead, BufReader, Read, Write},
    net::TcpListener,
    time::Duration,
};

#[tokio::test]
async fn ignored_range_stops_reading_without_waiting_for_eof() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::task::spawn_blocking(move || {
        let (stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(4)))
            .unwrap();
        let mut stream = BufReader::new(stream);
        let mut headers = String::new();
        loop {
            let offset = headers.len();
            assert!(stream.read_line(&mut headers).unwrap() > 0);
            if &headers[offset..] == "\r\n" {
                break;
            }
        }
        assert!(headers.to_ascii_lowercase().contains("range: bytes=0-63"));
        write!(
            stream.get_mut(),
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n80\r\n{}\r\n",
            "x".repeat(128)
        )
        .unwrap();
        // Keep the body open. The client must close the connection at its cap.
        assert_eq!(stream.read(&mut [0]).unwrap(), 0);
    });
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap();
    let response = client
        .get(url)
        .header(reqwest::header::RANGE, "bytes=0-63")
        .send()
        .await
        .unwrap();
    assert_eq!(
        super::read_prefix(response, 64).await.unwrap(),
        vec![b'x'; 64]
    );
    server.await.unwrap();
}
