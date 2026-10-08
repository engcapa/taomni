//! Exercises the real Tao/Win32 message loop without touching the user's desktop.
//! A pending cross-thread focus message reenters keyboard processing at PeekMessageW.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Duration, Instant};
use tao::{
    event::Event,
    event_loop::{ControlFlow, EventLoopBuilder},
    platform::windows::WindowExtWindows,
    window::WindowBuilder,
};

type SubclassProc = unsafe extern "system" fn(isize, u32, usize, isize, usize, usize) -> isize;

#[link(name = "comctl32")]
unsafe extern "system" {
    fn SetWindowSubclass(hwnd: isize, callback: SubclassProc, id: usize, data: usize) -> i32;
    fn DefSubclassProc(hwnd: isize, msg: u32, wparam: usize, lparam: isize) -> isize;
}

#[link(name = "user32")]
unsafe extern "system" {
    fn GetQueueStatus(flags: u32) -> u32;
    fn PostMessageW(hwnd: isize, msg: u32, wparam: usize, lparam: isize) -> i32;
    fn SendMessageTimeoutW(
        hwnd: isize,
        msg: u32,
        wparam: usize,
        lparam: isize,
        flags: u32,
        timeout: u32,
        result: *mut usize,
    ) -> isize;
}

const QS_SENDMESSAGE: u32 = 0x0040;
const VK_F24: usize = 0x87;
static ARMED: AtomicBool = AtomicBool::new(true);
static INSIDE_KEY: AtomicBool = AtomicBool::new(false);
static KEY_COMPLETED: AtomicBool = AtomicBool::new(false);
static NESTED_FOCUS: AtomicUsize = AtomicUsize::new(0);

unsafe extern "system" fn subclass(
    hwnd: isize,
    msg: u32,
    wparam: usize,
    lparam: isize,
    _id: usize,
    key_msg: usize,
) -> isize {
    let injected_key =
        msg as usize == key_msg && wparam == VK_F24 && ARMED.swap(false, Ordering::SeqCst);
    if injected_key {
        INSIDE_KEY.store(true, Ordering::SeqCst);
        let deadline = Instant::now() + Duration::from_secs(3);
        // GetQueueStatus does NOT dispatch sent messages. Wait until the worker's
        // SendMessage is pending, then let Tao's own keyboard PeekMessageW do so.
        while unsafe { GetQueueStatus(QS_SENDMESSAGE) } & (QS_SENDMESSAGE << 16) == 0 {
            if Instant::now() >= deadline {
                eprintln!("ERROR: no pending sent message; regression not exercised");
                std::process::exit(3);
            }
            std::thread::yield_now();
        }
    }
    if (msg == 0x0007 || msg == 0x0008) && INSIDE_KEY.load(Ordering::SeqCst) {
        NESTED_FOCUS.fetch_add(1, Ordering::SeqCst);
    }
    let result = unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) };
    if injected_key {
        KEY_COMPLETED.store(true, Ordering::SeqCst);
        INSIDE_KEY.store(false, Ordering::SeqCst);
    }
    result
}

fn main() {
    let args: Vec<_> = std::env::args().collect();
    let key_msg = match args.get(1).map(String::as_str) {
        Some("down") => 0x0100,
        Some("up") => 0x0101,
        Some("sysdown") => 0x0104,
        Some("sysup") => 0x0105,
        _ => panic!("expected down|up|sysdown|sysup and set|kill"),
    };
    let focus_msg = match args.get(2).map(String::as_str) {
        Some("set") => 0x0007,
        Some("kill") => 0x0008,
        _ => panic!("expected set|kill"),
    };
    let mut event_loop = EventLoopBuilder::<()>::with_user_event().build();
    let window = WindowBuilder::new()
        .with_title("Taomni input reentrancy regression")
        .with_visible(false)
        .build(&event_loop)
        .unwrap();
    let hwnd = window.hwnd();
    assert_ne!(
        unsafe { SetWindowSubclass(hwnd, subclass, 1, key_msg as usize) },
        0
    );
    let proxy = event_loop.create_proxy();
    std::thread::spawn(move || {
        let lparam = if key_msg == 0x0101 || key_msg == 0x0105 {
            0xc0760001u32 as isize
        } else {
            0x00760001
        };
        assert_ne!(unsafe { PostMessageW(hwnd, key_msg, VK_F24, lparam) }, 0);
        let deadline = Instant::now() + Duration::from_secs(3);
        while !INSIDE_KEY.load(Ordering::SeqCst) {
            if Instant::now() >= deadline {
                eprintln!("ERROR: keyboard handler never started");
                std::process::exit(3);
            }
            std::thread::yield_now();
        }
        let mut result = 0;
        // A bounded watchdog exits the probe process if the UI locks itself.
        let delivered = unsafe { SendMessageTimeoutW(hwnd, focus_msg, 0, 0, 3, 1500, &mut result) };
        // Returning from the nested focus handler can wake this thread before
        // the outer key handler returns. Wait for that return before probing.
        let deadline = Instant::now() + Duration::from_millis(1500);
        while !KEY_COMPLETED.load(Ordering::SeqCst) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(1));
        }
        let responsive = unsafe { SendMessageTimeoutW(hwnd, 0, 0, 0, 3, 1500, &mut result) };
        let nested = NESTED_FOCUS.load(Ordering::SeqCst);
        let completed = KEY_COMPLETED.load(Ordering::SeqCst);
        println!(
            "{{\"focus_delivered\":{},\"responsive\":{},\"nested_focus\":{},\"key_completed\":{}}}",
            delivered != 0,
            responsive != 0,
            nested,
            completed,
        );
        if nested == 0 {
            eprintln!("ERROR: no nested focus; regression not exercised");
            std::process::exit(3);
        }
        if delivered == 0 || responsive == 0 || !completed {
            std::process::exit(2);
        }
        proxy.send_event(()).unwrap();
    });
    use tao::platform::run_return::EventLoopExtRunReturn;
    event_loop.run_return(|event, _, flow| {
        *flow = if matches!(event, Event::UserEvent(())) {
            ControlFlow::Exit
        } else {
            ControlFlow::Wait
        };
    });
}
