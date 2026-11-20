"""Show an external QR image on the Windows or X11 QA desktop."""
import sys
import tkinter as tk


def main(path: str, x: int, y: int) -> None:
    root = tk.Tk()
    root.title("Taomni QA MFA QR")
    root.configure(background="white")
    image = tk.PhotoImage(file=path)
    tk.Label(root, image=image, background="white", borderwidth=0).pack(padx=24, pady=24)
    root.geometry(f"+{x}+{y}")
    root.attributes("-topmost", True)

    def ready() -> None:
        root.update_idletasks()
        print(
            "WINDOW-READY", root.winfo_rootx(), root.winfo_rooty(),
            root.winfo_width(), root.winfo_height(), flush=True,
        )

    root.after(300, ready)
    root.mainloop()


if __name__ == "__main__":
    main(sys.argv[1], int(sys.argv[2]), int(sys.argv[3]))
