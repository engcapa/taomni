use super::configuration::compression_name;
use super::configuration::parse_compression;
use ironrdp::pdu::rdp::client_info::CompressionType;

use super::configuration::{MSTSC_LIKE_CODECS, client_codecs};

#[test]
fn compression_levels_parse_and_reject_unknown_values() {
    for name in ["none", "k8", "k64", "rdp6", "rdp61"] {
        assert_eq!(compression_name(parse_compression(name).unwrap()), name);
    }
    assert!(parse_compression("rdp7").is_err());
    assert_eq!(
        parse_compression("rdp61").unwrap(),
        Some(CompressionType::Rdp61)
    );
}

fn ids(config: &str) -> Vec<u8> {
    let config: Vec<String> = config.split(',').map(str::to_string).collect();
    client_codecs(&config)
        .unwrap()
        .0
        .iter()
        .map(|c| c.id)
        .collect()
}

#[test]
fn default_codecs_match_what_mstsc_offers() {
    assert_eq!(ids(MSTSC_LIKE_CODECS), vec![3]);
}

#[test]
fn qoiz_can_be_requested_for_taomni_client_parity() {
    assert!(ids("remotefx,qoiz").contains(&0x0B));
}
