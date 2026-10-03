export class Command {
  constructor(_program: string, _args?: string | string[]) {}

  async execute(): Promise<{ code: number; stdout: string; stderr: string }> {
    return { code: 0, stdout: "", stderr: "" };
  }
}

export class Child {
  pid: number = 0;
  async kill(): Promise<void> {}
  async write(_data: string | Uint8Array): Promise<void> {}
}

export async function open(_path: string, _openWith?: string): Promise<void> {}
