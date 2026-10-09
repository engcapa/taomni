//! Neutral hotwords mapped to managed vendor vocabularies, cached by content.
use crate::{ai::config::AsrProviderConfig, proxy::ResolvedProxy};
use sha2::{Digest, Sha256};

pub fn validate(words: &[String]) -> Result<Vec<String>, String> {
    if words.len() > 2000 {
        return Err("ASR_HOTWORDS: at most 2000 terms are supported".into());
    }
    let mut result = Vec::new();
    for word in words {
        let word = word.trim();
        if word.is_empty() {
            continue;
        }
        if word.chars().count() > 100 || word.chars().any(char::is_control) {
            return Err(
                "ASR_HOTWORDS: each term must be at most 100 characters without control characters"
                    .into(),
            );
        }
        if !result.iter().any(|s| s == word) {
            result.push(word.to_owned());
        }
    }
    Ok(result)
}

pub async fn prepare(
    provider: &str,
    config: &AsrProviderConfig,
    key: &str,
    words: &[String],
    proxy: Option<&ResolvedProxy>,
) -> Result<String, String> {
    if words.is_empty() || !["aliyun", "volcengine"].contains(&provider) {
        return Ok(String::new());
    }
    if provider == "aliyun"
        && words.iter().any(|w| {
            if w.is_ascii() {
                w.split_whitespace().count() > 7
            } else {
                w.chars().count() > 15
            }
        })
    {
        return Err("ASR_HOTWORDS: Aliyun terms allow 15 non-ASCII characters or 7 space-separated ASCII words".into());
    }
    if provider == "volcengine" && config.app_id.parse::<u64>().is_err() {
        return Err("ASR_HOTWORDS: configure the Volcengine application ID before uploading a hotword table".into());
    }
    let fingerprint = hex::encode(Sha256::digest(
        serde_json::to_vec(&(
            provider,
            &config.model,
            &config.vocabulary_endpoint,
            &config.app_id,
            key,
            words,
        ))
        .unwrap(),
    ));
    let dir = crate::resolved_cache_dir()
        .unwrap_or_else(|| ".".into())
        .join("taomni/asr-vocabulary");
    let cache = dir.join(format!("{fingerprint}.json"));
    if let Ok(text) = tokio::fs::read_to_string(&cache).await {
        if let Ok(id) = serde_json::from_str::<String>(&text) {
            if !id.is_empty() {
                return Ok(id);
            }
        }
    }
    let mut builder = reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(std::time::Duration::from_secs(20))
        .timeout(std::time::Duration::from_secs(30));
    if let Some(proxy) = proxy {
        let url = proxy.to_url().replacen("socks5://", "socks5h://", 1);
        builder = builder
            .proxy(reqwest::Proxy::all(url).map_err(|_| "ASR_PROXY: invalid vocabulary proxy")?);
    }
    let client = builder
        .build()
        .map_err(|_| "ASR_HOTWORDS: cannot create HTTP client")?;
    let request = if provider == "aliyun" {
        if config.vocabulary_endpoint.trim().is_empty() {
            return Err(
                "ASR_HOTWORDS: configure the Aliyun vocabulary HTTPS endpoint for your workspace"
                    .into(),
            );
        }
        let url = url::Url::parse(&config.vocabulary_endpoint)
            .map_err(|_| "ASR_HOTWORDS: invalid vocabulary endpoint")?;
        if url.scheme() != "https" {
            return Err("ASR_HOTWORDS: vocabulary endpoint must use HTTPS".into());
        }
        client.post(url).bearer_auth(key).json(&serde_json::json!({"model":"speech-biasing","input":{
            "action":"create_vocabulary","target_model":config.model,"prefix":"taomni",
            "vocabulary":words.iter().map(|w| serde_json::json!({"text":w,"weight":4})).collect::<Vec<_>>()}}))
    } else {
        // Official API-key management endpoint. Multipart only contains fixed
        // field names; the validated terms cannot inject a MIME boundary.
        let boundary = format!("taomni{}", uuid::Uuid::new_v4().simple());
        let mut body = String::new();
        for (field, value) in [
            ("Action", "CreateBoostingTable".to_owned()),
            ("Version", "2022-08-30".into()),
            ("AppID", config.app_id.clone()),
            (
                "BoostingTableName",
                format!("taomni-{}", &fingerprint[..20]),
            ),
        ] {
            body.push_str(&format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{field}\"\r\n\r\n{value}\r\n"));
        }
        body.push_str(&format!("--{boundary}\r\nContent-Disposition: form-data; name=\"File\"; filename=\"hotwords.txt\"\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n{}\r\n--{boundary}--\r\n", words.join("\n")));
        client
            .post("https://openspeech.bytedance.com/api/proxy/invoke?Action=CreateBoostingTable")
            .header("X-Api-Key", key)
            .header(
                "Content-Type",
                format!("multipart/form-data; boundary={boundary}"),
            )
            .body(body)
    };
    let id = execute_vocabulary_request(provider, request).await?;
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|_| "ASR_HOTWORDS: cannot persist vocabulary ID")?;
    let part = cache.with_extension("part");
    tokio::fs::write(&part, serde_json::to_vec(&id).unwrap())
        .await
        .map_err(|_| "ASR_HOTWORDS: cannot persist vocabulary ID")?;
    tokio::fs::rename(part, cache)
        .await
        .map_err(|_| "ASR_HOTWORDS: cannot publish vocabulary ID")?;
    Ok(id)
}

async fn execute_vocabulary_request(
    provider: &str,
    request: reqwest::RequestBuilder,
) -> Result<String, String> {
    let response = request
        .send()
        .await
        .map_err(|_| "ASR_HOTWORDS: vocabulary request failed; check proxy and endpoint")?;
    if !response.status().is_success() {
        return Err(format!(
            "ASR_HOTWORDS: vocabulary service returned HTTP {}",
            response.status().as_u16()
        ));
    }
    let value: serde_json::Value = response
        .json()
        .await
        .map_err(|_| "ASR_HOTWORDS: invalid vocabulary response")?;
    let path = if provider == "aliyun" {
        "/output/vocabulary_id"
    } else {
        "/Result/BoostingTableID"
    };
    let id = value
        .pointer(path)
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or("ASR_HOTWORDS: provider rejected vocabulary; check application/model limits")?;
    Ok(id.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn native_http_vocabulary_responses_and_failures() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        for (provider, status, body, expected) in [
            (
                "aliyun",
                200,
                r#"{"output":{"vocabulary_id":"vocab-1"}}"#,
                Some("vocab-1"),
            ),
            (
                "volcengine",
                200,
                r#"{"Result":{"BoostingTableID":"table-2"}}"#,
                Some("table-2"),
            ),
            ("aliyun", 401, r#"{"secret":"must not escape"}"#, None),
            ("volcengine", 200, r#"{"Result":{}}"#, None),
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut headers = Vec::new();
                while !headers.ends_with(b"\r\n\r\n") {
                    headers.push(stream.read_u8().await.unwrap());
                }
                let response = format!(
                    "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(response.as_bytes()).await.unwrap();
            });
            let client = reqwest::Client::builder().no_proxy().build().unwrap();
            let result =
                execute_vocabulary_request(provider, client.post(format!("http://{address}")))
                    .await;
            server.await.unwrap();
            match expected {
                Some(id) => assert_eq!(result.unwrap(), id),
                None => {
                    let error = result.unwrap_err();
                    assert!(error.starts_with("ASR_HOTWORDS:"));
                    assert!(!error.contains("must not escape"));
                }
            }
        }
    }
    #[test]
    fn validates_neutral_terms_without_silently_truncating() {
        assert_eq!(
            validate(&[" Rust ".into(), "Rust".into(), "src/main.rs".into()]).unwrap(),
            ["Rust", "src/main.rs"]
        );
        assert!(validate(&vec!["term".into(); 2001]).is_err());
        assert!(validate(&["bad\nword".into()]).is_err());
    }
}
