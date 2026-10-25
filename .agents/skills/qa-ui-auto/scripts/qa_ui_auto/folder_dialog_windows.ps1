$ErrorActionPreference = "Stop"
Add-Type @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Runtime.InteropServices;
using System.Text;
public static class QaFolderDialog {
    public delegate bool Enumerate(IntPtr window, IntPtr data);
    [DllImport("user32.dll")] static extern bool EnumWindows(Enumerate callback, IntPtr data);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr owner, Enumerate callback, IntPtr data);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr window);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr window);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern IntPtr SetFocus(IntPtr window);
    [DllImport("user32.dll")] static extern IntPtr GetFocus();
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint from, uint to, bool attach);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, Input[] inputs, int size);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    [StructLayout(LayoutKind.Sequential)] struct MouseInput {
        public int x, y; public uint data, flags, time; public UIntPtr extra;
    }
    [StructLayout(LayoutKind.Sequential)] struct KeyInput {
        public ushort key, scan; public uint flags, time; public UIntPtr extra;
    }
    [StructLayout(LayoutKind.Explicit)] struct InputData {
        [FieldOffset(0)] public MouseInput mouse;
        [FieldOffset(0)] public KeyInput keyboard;
    }
    [StructLayout(LayoutKind.Sequential)] struct Input { public uint type; public InputData data; }
    public static string Text(IntPtr window) {
        var value = new StringBuilder(32768); GetWindowText(window, value, value.Capacity); return value.ToString();
    }
    public static string Class(IntPtr window) {
        var value = new StringBuilder(256); GetClassName(window, value, value.Capacity); return value.ToString();
    }
    private static int ProcessId(IntPtr window) { uint pid; GetWindowThreadProcessId(window, out pid); return (int)pid; }
    public static IntPtr[] Windows(IntPtr owner) {
        var found = new List<IntPtr>();
        Enumerate collect = (window, data) => { found.Add(window); return true; };
        if (owner == IntPtr.Zero) EnumWindows(collect, IntPtr.Zero); else EnumChildWindows(owner, collect, IntPtr.Zero);
        return found.ToArray();
    }
    private static IntPtr FindOwnedDialog(string application, string title) {
        var deadline = DateTime.UtcNow.AddSeconds(20);
        do {
            var owned = new List<IntPtr>();
            foreach (var window in Windows(IntPtr.Zero)) {
                if (!IsWindowVisible(window) || Class(window) != "#32770" || Text(window) != title) continue;
                try {
                    using (var process = Process.GetProcessById(ProcessId(window))) {
                        if (String.Equals(Path.GetFullPath(process.MainModule.FileName), application, StringComparison.OrdinalIgnoreCase)) {
                            owned.Add(window);
                        }
                    }
                } catch (System.ComponentModel.Win32Exception) { }
                  catch (ArgumentException) { }
                  catch (InvalidOperationException) { }
            }
            if (owned.Count == 1) return owned[0];
            Thread.Sleep(100);
        } while (DateTime.UtcNow < deadline);
        throw new InvalidOperationException("No unique Common Item Dialog owned by the QA executable");
    }

    private static IntPtr Control(IntPtr dialog, int id, string type) {
        var found = new List<IntPtr>();
        var details = new StringBuilder();
        foreach (var window in Windows(dialog)) {
            var controlId = GetDlgCtrlID(window);
            var controlClass = Class(window);
            if (controlId == id && controlClass == type && IsWindowVisible(window)) found.Add(window);
            details.AppendFormat("id={0},class={1},text={2}; ", controlId, controlClass, Text(window));
        }
        if (found.Count != 1) throw new InvalidOperationException("Chooser control " + id + "/" + type + " is not unique: " + details);
        return found[0];
    }

    private static bool Open(IntPtr dialog) {
        return IsWindow(dialog) && IsWindowVisible(dialog);
    }

    private static bool Click(IntPtr dialog, int id) {
        var button = Control(dialog, id, "Button");
        if (!IsWindowEnabled(button)) return false;
        // BM_CLICK operates the native button once. Enter must not leak into
        // the application's Add modal after the system dialog has closed.
        if (!PostMessage(button, 0x00F5, IntPtr.Zero, IntPtr.Zero)) {
            throw new InvalidOperationException("Chooser button could not receive BM_CLICK: " + id);
        }
        Console.Error.WriteLine("Chooser button {0}: {1}", id, Text(button));
        return true;
    }

    private static Input Key(ushort key, ushort scan = 0, uint flags = 0) {
        return new Input { type = 1, data = new InputData { keyboard = new KeyInput { key = key, scan = scan, flags = flags } } };
    }

    private static void EnterPath(IntPtr dialog, IntPtr edit, string path) {
        SetForegroundWindow(dialog);
        uint ignored;
        uint ownerThread = GetWindowThreadProcessId(edit, out ignored);
        uint currentThread = GetCurrentThreadId();
        if (!AttachThreadInput(currentThread, ownerThread, true)) {
            throw new InvalidOperationException("Could not attach to the owned chooser input thread");
        }
        try {
            SetFocus(edit);
            if (GetForegroundWindow() != dialog || GetFocus() != edit) {
                throw new InvalidOperationException("Owned chooser folder field did not receive native focus");
            }
        } finally { AttachThreadInput(currentThread, ownerThread, false); }
        // Real keyboard input is required: WM_SETTEXT changes the rendered
        // Edit text but leaves IFileDialog's internal selection unchanged.
        var inputs = new List<Input> { Key(0x11), Key(0x41), Key(0x41, 0, 2), Key(0x11, 0, 2) };
        foreach (char character in path) {
            inputs.Add(Key(0, character, 4));
            inputs.Add(Key(0, character, 6));
        }
        var values = inputs.ToArray();
        if (SendInput((uint)values.Length, values, Marshal.SizeOf(typeof(Input))) != values.Length) {
            throw new InvalidOperationException("Native chooser keyboard input was not delivered completely");
        }
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (Text(edit) != path && DateTime.UtcNow < deadline) Thread.Sleep(50);
        if (Text(edit) != path) throw new InvalidOperationException("Folder path was not entered completely: " + Text(edit));
        Console.Error.WriteLine("Native folder field input: {0}", Text(edit));
    }

    public static Dictionary<string, object> Run(string application, string title, string action, string path) {
        application = Path.GetFullPath(application);
        var dialog = FindOwnedDialog(application, title);
        int pid = ProcessId(dialog);
        Console.Error.WriteLine("Owned chooser HWND={0}, pid={1}, title={2}", dialog, pid, Text(dialog));
        if (action == "cancel") {
            if (!Click(dialog, 2)) throw new InvalidOperationException("Chooser Cancel is disabled");
        } else if (action == "choose") {
            // 1152 is the folder field; the last UIA Edit is the Search box.
            var edit = Control(dialog, 1152, "Edit");
            EnterPath(dialog, edit, path);
            var deadline = DateTime.UtcNow.AddSeconds(10);
            bool invoked = false;
            do {
                if (!Open(dialog)) throw new InvalidOperationException("Chooser closed before accepting the path");
                invoked = Click(dialog, 1);
                if (invoked) break;
                Thread.Sleep(100);
            } while (DateTime.UtcNow < deadline);
            if (!invoked) throw new InvalidOperationException("Chooser Open is disabled");
        } else {
            throw new ArgumentException("Unknown chooser action: " + action);
        }
        var closedDeadline = DateTime.UtcNow.AddSeconds(10);
        while (Open(dialog) && DateTime.UtcNow < closedDeadline) Thread.Sleep(100);
        if (Open(dialog)) throw new InvalidOperationException("Folder chooser did not close");
        return new Dictionary<string, object> {
            { "transport", "Windows Common Item Dialog controls" },
            { "window", dialog.ToInt64() }, { "pid", pid }, { "application", application }
        };
    }
}
"@
# Keep primitive Win32 calls inside typed C#. PowerShell's dynamic pipeline
# binder otherwise rejects native Int32 return values on the hosted desktop.
[QaFolderDialog]::Run($env:QA_PICKER_APPLICATION, $env:QA_PICKER_TITLE, $env:QA_PICKER_ACTION, $env:QA_PICKER_PATH) |
    ConvertTo-Json -Depth 4 -Compress
