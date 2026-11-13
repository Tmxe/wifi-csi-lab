"""Generate a small stream of UDP packets for the isolated CSI-Lab access point."""

import socket
import time


def main():
    target = ("192.168.4.1", 4210)
    payload = b"CSI-LAB" + bytes(89)
    print("Join the CSI-Lab Wi-Fi network first. Press Ctrl+C to stop.")
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sender:
            deadline = time.monotonic()
            while True:
                sender.sendto(payload, target)
                deadline = max(deadline + 0.1, time.monotonic())
                time.sleep(max(0, deadline - time.monotonic()))
    except KeyboardInterrupt:
        print("\nStopped.")
    except OSError as error:
        raise SystemExit(f"Could not send probes ({error.strerror}). Check the lab connection.") from None


if __name__ == "__main__":
    main()
