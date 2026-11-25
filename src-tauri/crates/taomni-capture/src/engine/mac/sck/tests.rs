use std::ptr::NonNull;
use std::time::Duration;

use objc2_core_foundation::{CFMutableDictionary, CFNumber, CFRetained};
use objc2_core_media::{
    CMSampleBuffer, CMSampleTimingInfo, CMTime, CMVideoFormatDescriptionCreateForImageBuffer,
};
use objc2_core_video::{CVPixelBufferCreate, kCVPixelFormatType_32BGRA};
use objc2_screen_capture_kit::{SCFrameStatus, SCStreamConfiguration, SCStreamFrameInfoStatus};

use super::{Frame, FrameSlot, configure_stream, retain_bgra_frame};

fn frame(value: u8) -> Frame {
    Frame::bgra(vec![value, 0, 0, 0], 0, 0, 1, 1, 4)
}

#[test]
fn frame_slot_retains_only_the_latest_callback_frame() {
    let slot = FrameSlot::new();
    slot.publish(frame(1));
    slot.publish(frame(2));
    assert_eq!(slot.take(Duration::from_millis(1)).unwrap().data[0], 2);
}

#[test]
fn static_desktop_reports_an_idle_tick_instead_of_an_error() {
    // ScreenCaptureKit delivers no usable frame while the desktop is
    // unchanged. Reporting that as an error would end the capture thread and
    // freeze the connected client on its last frame.
    let slot = FrameSlot::new();
    assert!(
        slot.take_or_idle(Duration::from_millis(1))
            .expect("idle is not a failure")
            .is_none()
    );

    slot.publish(frame(7));
    let frame = slot
        .take_or_idle(Duration::from_millis(1))
        .expect("published frame is delivered")
        .expect("frame is present");
    assert_eq!(frame.data[0], 7);
}

#[test]
fn stopped_stream_is_an_error_on_both_paths() {
    let slot = FrameSlot::new();
    slot.stop("display disconnected");

    let idle_error = slot.take_or_idle(Duration::from_millis(1)).unwrap_err();
    assert!(idle_error.to_string().contains("display disconnected"));
    assert!(slot.take(Duration::from_millis(1)).is_err());
}

#[test]
fn required_frame_still_fails_when_none_arrives() {
    // The initial frame and the desktop-size probe genuinely need pixels.
    let slot = FrameSlot::new();
    let error = slot.take(Duration::from_millis(1)).unwrap_err();
    assert!(error.to_string().contains("produced no frame"));
}

#[test]
fn stream_configuration_is_safe_on_the_deployment_target() {
    let configuration = unsafe { SCStreamConfiguration::new() };
    configure_stream(&configuration, 1920, 1080);

    unsafe {
        assert_eq!(configuration.width(), 1920);
        assert_eq!(configuration.height(), 1080);
        assert_eq!(configuration.pixelFormat(), kCVPixelFormatType_32BGRA);
        assert!(!configuration.showsCursor());
        assert!(!configuration.capturesAudio());
    }
}

#[test]
fn idle_samples_with_an_image_do_not_republish_the_previous_frame() {
    let mut pixel_buffer = std::ptr::null_mut();
    assert_eq!(
        unsafe {
            CVPixelBufferCreate(
                None,
                2,
                2,
                kCVPixelFormatType_32BGRA,
                None,
                NonNull::from(&mut pixel_buffer),
            )
        },
        0
    );
    let pixel_buffer = unsafe { CFRetained::from_raw(NonNull::new(pixel_buffer).unwrap()) };
    let mut description = std::ptr::null();
    assert_eq!(
        unsafe {
            CMVideoFormatDescriptionCreateForImageBuffer(
                None,
                &pixel_buffer,
                NonNull::from(&mut description),
            )
        },
        0
    );
    let description =
        unsafe { CFRetained::from_raw(NonNull::new(description.cast_mut()).unwrap()) };
    // These fixed, nonzero timescales satisfy CoreMedia's constructor.
    let mut timing = unsafe {
        CMSampleTimingInfo {
            duration: CMTime::new(1, 60),
            presentationTimeStamp: CMTime::new(0, 1),
            decodeTimeStamp: CMTime::new(0, 1),
        }
    };
    let mut sample = std::ptr::null_mut();
    assert_eq!(
        unsafe {
            CMSampleBuffer::create_ready_with_image_buffer(
                None,
                &pixel_buffer,
                &description,
                NonNull::from(&mut timing),
                NonNull::from(&mut sample),
            )
        },
        0
    );
    let sample = unsafe { CFRetained::from_raw(NonNull::new(sample).unwrap()) };
    assert!(unsafe { sample.image_buffer() }.is_some());
    let attachments = unsafe { sample.sample_attachments_array(true) }.unwrap();
    assert_eq!(attachments.count(), 1);
    let dictionary = unsafe {
        attachments
            .value_at_index(0)
            .cast::<CFMutableDictionary>()
            .as_ref()
    }
    .unwrap();
    for status in [
        SCFrameStatus::Complete,
        SCFrameStatus::Idle,
        SCFrameStatus::Blank,
        SCFrameStatus::Suspended,
        SCFrameStatus::Started,
        SCFrameStatus::Stopped,
    ] {
        let number = CFNumber::new_isize(status.0);
        unsafe {
            CFMutableDictionary::set_value(
                Some(dictionary),
                std::ptr::from_ref(SCStreamFrameInfoStatus).cast(),
                (&*number as *const CFNumber).cast(),
            );
        }
        assert_eq!(
            retain_bgra_frame(&sample).unwrap().is_some(),
            status == SCFrameStatus::Complete,
            "status={status:?}"
        );
    }
}
