use serde::{Deserialize, Serialize};

use crate::{
    CHUNK_BYTES,
    native_channel::{Channel, Endpoint, Offer},
};

use super::{FRAME_COUNT, Frame, Workload, pixels_for};

#[derive(Deserialize, Serialize)]
pub(super) struct Input<T> {
    endpoint: T,
    workload: Workload,
}

pub(super) fn input(offer: &Offer, workload: Workload) -> Input<&Endpoint> {
    Input {
        endpoint: offer.endpoint(),
        workload,
    }
}

pub(super) async fn deliver(channel: &mut Channel, frame: &Frame) {
    let header = frame.sequence.to_le_bytes();
    channel.send(header.to_vec().into()).await.unwrap();
    for offset in (0..frame.pixels.len()).step_by(CHUNK_BYTES) {
        let end = (offset + CHUNK_BYTES).min(frame.pixels.len());
        channel.send(frame.pixels.slice(offset..end)).await.unwrap();
    }
    assert_eq!(channel.receive().await.unwrap().unwrap().as_ref(), header);
}

pub(super) async fn receive(input: Input<Endpoint>) {
    let patterns = input.workload.pixels();
    let mut channel = Channel::connect(input.endpoint).await.unwrap();
    let mut pixels = vec![0; input.workload.byte_len()];
    let mut previous = None;
    while let Some(header) = channel.receive().await.unwrap() {
        let sequence = u64::from_le_bytes(header.as_ref().try_into().expect("frame sequence"));
        assert!(sequence < FRAME_COUNT);
        assert!(previous.is_none_or(|previous| previous < sequence));
        for output in pixels.chunks_mut(CHUNK_BYTES) {
            let chunk = channel.receive().await.unwrap().expect("complete frame");
            output.copy_from_slice(&chunk);
        }
        assert!(pixels.as_slice() == pixels_for(&patterns, sequence).as_ref());
        previous = Some(sequence);
        channel.send(header).await.unwrap();
    }
    assert_eq!(previous, Some(FRAME_COUNT - 1));
}
