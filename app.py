import subprocess
import tkinter as tk

bot_process = None
backend_process = None
frontend_process = None


def start_all():
    global bot_process, backend_process, frontend_process

    if not backend_process:
        backend_process = subprocess.Popen(
            ["cmd", "/c", "cd backend && uvicorn main:app --reload"]
        )

    if not frontend_process:
        frontend_process = subprocess.Popen(
            ["cmd", "/c", "cd frontend && npm run dev"]
        )

    if not bot_process:
        bot_process = subprocess.Popen(["python", "bot.py"])

    status_label.config(text="🟢 System Running")


def stop_all():
    global bot_process, backend_process, frontend_process

    for p in [bot_process, backend_process, frontend_process]:
        if p:
            p.terminate()

    bot_process = None
    backend_process = None
    frontend_process = None

    status_label.config(text="🔴 System Stopped")


# GUI
root = tk.Tk()
root.title("ScrimWatch Control Panel")
root.geometry("350x250")

status_label = tk.Label(root, text="🔴 System Stopped", font=("Arial", 14))
status_label.pack(pady=20)

start_btn = tk.Button(root, text="🚀 Start System", command=start_all)
start_btn.pack(pady=10)

stop_btn = tk.Button(root, text="🛑 Stop System", command=stop_all)
stop_btn.pack(pady=10)

root.mainloop()