import { Sentry, type Session, type Offer, type Transfer } from "zmodem.js";

export type ZmodemState = "idle" | "receiving" | "sending";

export interface ZmodemProgress {
  fileName: string;
  fileSize: number;
  bytesTransferred: number;
}

export interface ZmodemCallbacks {
  onTerminalData: (data: Uint8Array) => void;
  onStateChange: (state: ZmodemState, progress?: ZmodemProgress) => void;
  onProgress: (progress: ZmodemProgress) => void;
  /** Called once before the first file arrives. Return the directory to save into, or null to cancel. */
  onSelectSaveDir: () => Promise<string | null>;
  /** Called for each received file with the resolved full path and bytes. */
  onWriteFile: (fullPath: string, bytes: Uint8Array) => Promise<void>;
  onComplete: (fileName: string) => void;
  onError: (message: string) => void;
}

const SEND_CHUNK = 8192;

/**
 * Wraps a zmodem.js Sentry to detect and handle ZMODEM transfers over the
 * existing SSH byte stream. Feed all terminal output through consume();
 * the sentry routes non-ZMODEM bytes to onTerminalData and takes over the
 * channel when a handshake is detected.
 */
export class ZmodemSession {
  private readonly sentry: Sentry;
  private active = false;
  private pendingSend: Array<{ name: string; bytes: Uint8Array }> = [];

  constructor(
    sender: (data: Uint8Array) => void,
    private readonly callbacks: ZmodemCallbacks,
  ) {
    this.sentry = new Sentry({
      to_terminal: (octets: number[]) => {
        callbacks.onTerminalData(new Uint8Array(octets));
      },
      sender: (octets: number[]) => {
        sender(new Uint8Array(octets));
      },
      on_retract: () => {
        if (this.active) {
          this.active = false;
          this.pendingSend = [];
          callbacks.onStateChange("idle");
        }
      },
      on_detect: (detection) => {
        const zsession = detection.confirm();
        if (zsession.type === "receive") {
          this.doReceive(zsession);
        } else {
          if (this.pendingSend.length > 0) {
            const files = this.pendingSend;
            this.pendingSend = [];
            this.doSendAll(zsession, files);
          } else {
            zsession.abort();
            this.callbacks.onError("Unexpected ZMODEM send session (no file queued)");
          }
        }
      },
    });
  }

  consume(data: Uint8Array): void {
    try {
      this.sentry.consume(Array.from(data));
    } catch (err) {
      this.callbacks.onError(err instanceof Error ? err.message : String(err));
      this.active = false;
      this.pendingSend = [];
      this.callbacks.onStateChange("idle");
    }
  }

  get isActive(): boolean {
    return this.active;
  }

  queueSend(files: Array<{ name: string; bytes: Uint8Array }>): void {
    this.pendingSend = files;
  }

  private doReceive(zsession: Session): void {
    this.active = true;
    this.callbacks.onStateChange("receiving");

    void (async () => {
      const saveDir = await this.callbacks.onSelectSaveDir();
      if (!saveDir) {
        zsession.abort();
        this.active = false;
        this.callbacks.onStateChange("idle");
        return;
      }

      const sep = saveDir.includes("\\") ? "\\" : "/";
      const dirBase = saveDir.replace(/[/\\]+$/, "");

      zsession.on("offer", (offer: Offer) => {
        const details = offer.get_details();
        const progress: ZmodemProgress = {
          fileName: details.name,
          fileSize: details.size ?? 0,
          bytesTransferred: 0,
        };
        this.callbacks.onStateChange("receiving", progress);

        const chunks: Uint8Array[] = [];

        offer.on("input", (octets: number[]) => {
          const chunk = new Uint8Array(octets);
          chunks.push(chunk);
          progress.bytesTransferred += chunk.length;
          this.callbacks.onProgress({ ...progress });
        });

        offer.accept().then(() => {
          const bytes = mergeChunks(chunks);
          const fullPath = dirBase + sep + details.name;
          this.callbacks.onWriteFile(fullPath, bytes)
            .then(() => this.callbacks.onComplete(details.name))
            .catch((err: unknown) => {
              this.callbacks.onError(err instanceof Error ? err.message : String(err));
            });
        }).catch((err: unknown) => {
          this.callbacks.onError(err instanceof Error ? err.message : String(err));
        });
      });

      zsession.on("session_end", () => {
        this.active = false;
        this.callbacks.onStateChange("idle");
      });

      zsession.start();
    })();
  }

  private doSendAll(zsession: Session, files: Array<{ name: string; bytes: Uint8Array }>): void {
    this.active = true;
    const first = files[0];
    const progress: ZmodemProgress = {
      fileName: first.name,
      fileSize: first.bytes.length,
      bytesTransferred: 0,
    };
    this.callbacks.onStateChange("sending", progress);

    void (async () => {
      try {
        for (const { name, bytes } of files) {
          progress.fileName = name;
          progress.fileSize = bytes.length;
          progress.bytesTransferred = 0;
          this.callbacks.onStateChange("sending", { ...progress });

          const xfer: Transfer | undefined = await zsession.send_offer({
            name,
            size: bytes.length,
            mtime: Math.floor(Date.now() / 1000),
          });

          if (!xfer) {
            this.callbacks.onError(`Remote skipped file: ${name}`);
          } else {
            for (let offset = 0; offset < bytes.length; offset += SEND_CHUNK) {
              xfer.send(Array.from(bytes.slice(offset, offset + SEND_CHUNK)));
              progress.bytesTransferred = Math.min(offset + SEND_CHUNK, bytes.length);
              this.callbacks.onProgress({ ...progress });
            }
            await xfer.end([]);
            this.callbacks.onComplete(name);
          }
        }

        await zsession.close();
      } catch (err) {
        this.callbacks.onError(err instanceof Error ? err.message : String(err));
      } finally {
        this.active = false;
        this.callbacks.onStateChange("idle");
      }
    })();
  }
}

function mergeChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
