import { describe, expect, it } from "vitest";
import { parseMobaXtermSessions, serializeMobaXtermSessions } from "../../sessionImportExport";
import { session } from "./harness";

export function registersessionImportExportLifecycle3Cases() {

  describe("MobaXterm session import/export", () => {
    it("imports SSH sessions from nested bookmark folders", () => {
      const sshBasic = [
        "0",
        "sesafrazu01",
        "22",
        "azroot",
        "",
        "-1",
        "-1",
        "echo__PIPE__ok",
        "jump.example.com",
        "2222",
        "jump",
        "0",
        "0",
        "0",
        "_ProfileDir_\\keys\\id.ppk",
        "",
        "-1",
        "0",
        "0",
        "0",
        "",
        "1080",
        "",
        "0",
        "0",
        "1",
      ].join("%");
      const text = [
        "[Bookmarks]",
        "SubRep=Azure",
        "ImgNum=41",
        "[Bookmarks_1]",
        "SubRep=Azure\\PRE",
        "ImgNum=41",
        `sesafrazu01=#109#${sshBasic}#MobaFont%10%0%0%0%0%236,236,236%0,0,0%180,180,192%0%-1%0%%xterm%-1#0#SSH__DIEZE__comment#-1`,
      ].join("\r\n");

      const result = parseMobaXtermSessions(text, {
        targetFolder: "Imported",
        now: 3333,
        homeDir: "/home/importer",
      });

      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0]).toMatchObject({
        name: "sesafrazu01",
        session_type: "SSH",
        group_path: "User sessions / Imported / Azure / PRE",
        host: "sesafrazu01",
        port: 22,
        username: "azroot",
      });
      expect(result.sessions[0].auth_method).toEqual({ PrivateKey: { key_path: "/home/importer/keys/id.ppk" } });
      expect(JSON.parse(result.sessions[0].options_json)).toMatchObject({
        x11: true,
        compression: true,
        startupCmd: "echo|ok",
        jumpHost: "jump.example.com",
        jumpPort: "2222",
        jumpUser: "jump",
        description: "SSH#comment",
      });
    });

    it("resolves MobaXterm _ProfileDir_ private keys against Windows home", () => {
      const text = [
        "[Bookmarks]",
        "SubRep=aliyun",
        "ImgNum=41",
        "172.28.8.25 (grafana)=#109#0%172.28.8.25%22%yuhang.zhao%%-1%-1%%%%%0%0%0%_ProfileDir_\\.ssh\\id_rsa%%-1%0%0%0%%1080%%0%0%1%%0%%%%0%-1%-1%0#MobaFont%12%0%0%-1%15%236,236,236%30,30,30%180,180,192%0%-1%0%%xterm%-1%0%_Std_Colors_0_%80%24%0%1%-1%<none>%%0%0%-1%-1#0# #-1",
      ].join("\r\n");

      const result = parseMobaXtermSessions(text, {
        homeDir: "C:\\Users\\alice",
        now: 5555,
      });

      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0].auth_method).toEqual({
        PrivateKey: { key_path: "C:\\Users\\alice\\.ssh\\id_rsa" },
      });
    });

    it("imports SFTP private key path but does not import plaintext proxy passwords", () => {
      const text = [
        "[Bookmarks]",
        "SubRep=",
        "ImgNum=42",
        "sftp-one=#140#7%sftp.example.com%22%alice%-1%0%%%0%C:\\keys\\alice.ppk%4%proxy.example.com%1080%proxy-user%proxy-secret%C:\\tmp%-1#MobaFont%10%0%0%-1%15%236,236,236%30,30,30%180,180,192%0%-1%0%%xterm%-1#0# #-1",
      ].join("\r\n");

      const result = parseMobaXtermSessions(text, { now: 4444 });

      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0]).toMatchObject({
        name: "sftp-one",
        session_type: "SFTP",
        host: "sftp.example.com",
        username: "alice",
      });
      expect(result.sessions[0].auth_method).toEqual({ PrivateKey: { key_path: "C:\\keys\\alice.ppk" } });
      expect(JSON.stringify(result.sessions[0])).not.toContain("proxy-secret");
    });

    it("exports MobaXterm bookmark sections with CRLF and skips unsupported session types", () => {
      const result = serializeMobaXtermSessions([
        session(),
        session({
          id: "rdp-1",
          name: "Desktop",
          session_type: "RDP",
          group_path: "User sessions / Production / Desktops",
          host: "rdp.example.com",
          port: 3389,
          username: "admin",
          auth_method: "None",
          options_json: "{}",
        }),
        session({
          id: "local-1",
          name: "Local",
          session_type: "LocalShell",
          group_path: "User sessions / Production",
          host: "",
          port: 0,
          username: null,
          auth_method: "None",
          options_json: "{}",
        }),
      ], "Production");

      expect(result.text).toContain("[Bookmarks]\r\nSubRep=Production\r\nImgNum=41\r\n");
      expect(result.text).toContain("[Bookmarks_1]\r\nSubRep=Production\\Desktops\r\nImgNum=41\r\n");
      expect(result.text).toContain("Prod=#109#0%prod.example.com%22%deploy");
      expect(result.text).toContain("Desktop=#91#4%rdp.example.com%3389%admin");
      expect(result.text).not.toContain("Local=");
      expect(result.skipped).toBe(1);
    });
  });
}
