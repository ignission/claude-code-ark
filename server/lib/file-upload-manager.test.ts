import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileUploadManager } from "./file-upload-manager.js";

describe("FileUploadManager", () => {
  let tmpDir: string;
  let manager: FileUploadManager;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "file-upload-test-"));
    manager = new FileUploadManager(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const makeBase64 = (size: number): string =>
    Buffer.alloc(size, "a").toString("base64");

  describe("saveFile", () => {
    it("PNG画像を保存できる", async () => {
      const result = await manager.saveFile(
        "session-1",
        makeBase64(100),
        "image/png"
      );
      expect(result.filename).toMatch(/^\d+-[a-f0-9]+\.png$/);
      expect(result.path).toContain(path.join(tmpDir, "session-1"));
      const saved = await fs.readFile(result.path);
      expect(saved.length).toBe(100);
    });

    it("PDFを保存できる", async () => {
      const result = await manager.saveFile(
        "session-1",
        makeBase64(100),
        "application/pdf"
      );
      expect(result.filename).toMatch(/\.pdf$/);
    });

    it("text/markdownを保存できる", async () => {
      const result = await manager.saveFile(
        "session-1",
        makeBase64(50),
        "text/markdown"
      );
      expect(result.filename).toMatch(/\.md$/);
    });

    it("text/plainを保存できる", async () => {
      const result = await manager.saveFile(
        "session-1",
        makeBase64(50),
        "text/plain"
      );
      expect(result.filename).toMatch(/\.txt$/);
    });

    it("application/jsonを保存できる", async () => {
      const result = await manager.saveFile(
        "session-1",
        makeBase64(50),
        "application/json"
      );
      expect(result.filename).toMatch(/\.json$/);
    });

    it("application/octet-stream でも .csv 等の安全な拡張子なら許可される", async () => {
      const result = await manager.saveFile(
        "session-1",
        makeBase64(50),
        "application/octet-stream",
        "data.csv"
      );
      expect(result.filename).toMatch(/\.csv$/);
    });

    it("application/octet-stream + 未知の拡張子は拒否", async () => {
      await expect(
        manager.saveFile(
          "session-1",
          makeBase64(50),
          "application/octet-stream",
          "malware.exe"
        )
      ).rejects.toMatchObject({ code: "INVALID_MIME_TYPE" });
    });

    it("text/* の汎用MIMEで originalFilename から拡張子を補完できる", async () => {
      const result = await manager.saveFile(
        "session-1",
        makeBase64(50),
        "text/x-log",
        "debug.log"
      );
      expect(result.filename).toMatch(/\.log$/);
    });

    it("許可されていないMIMEで INVALID_MIME_TYPE", async () => {
      await expect(
        manager.saveFile(
          "session-1",
          makeBase64(100),
          "application/x-msdownload"
        )
      ).rejects.toMatchObject({
        name: "FileUploadManagerError",
        code: "INVALID_MIME_TYPE",
      });
    });

    it("10MB超で FILE_TOO_LARGE", async () => {
      const big = makeBase64(10 * 1024 * 1024 + 1);
      await expect(
        manager.saveFile("session-1", big, "image/png")
      ).rejects.toMatchObject({
        name: "FileUploadManagerError",
        code: "FILE_TOO_LARGE",
      });
    });

    it("空sessionIdで INVALID_SESSION_ID", async () => {
      await expect(
        manager.saveFile("", makeBase64(10), "image/png")
      ).rejects.toMatchObject({ code: "INVALID_SESSION_ID" });
    });

    it("'../../etc' のようなパス区切りを含むsessionIdはrejectされる", async () => {
      await expect(
        manager.saveFile("../../etc", makeBase64(10), "image/png")
      ).rejects.toMatchObject({ code: "INVALID_SESSION_ID" });
    });

    it("'.' のみのsessionIdはrejectされる", async () => {
      await expect(
        manager.saveFile(".", makeBase64(10), "image/png")
      ).rejects.toMatchObject({ code: "INVALID_SESSION_ID" });
    });

    it("'..' のみのsessionIdはrejectされる", async () => {
      await expect(
        manager.saveFile("..", makeBase64(10), "image/png")
      ).rejects.toMatchObject({ code: "INVALID_SESSION_ID" });
    });

    it("ファイル名生成が一意（衝突しない）", async () => {
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          manager.saveFile("session-1", makeBase64(10), "image/png")
        )
      );
      const filenames = results.map(r => r.filename);
      expect(new Set(filenames).size).toBe(5);
    });
  });

  describe("cleanup", () => {
    it("24h超のファイルだけ削除する", async () => {
      const newFile = await manager.saveFile(
        "session-1",
        makeBase64(10),
        "image/png"
      );
      const oldFile = await manager.saveFile(
        "session-1",
        makeBase64(10),
        "image/png"
      );
      const past = new Date(Date.now() - 25 * 60 * 60 * 1000);
      await fs.utimes(oldFile.path, past, past);

      const deleted = await manager.cleanup();
      expect(deleted).toBe(1);

      const newExists = await fs
        .stat(newFile.path)
        .then(() => true)
        .catch(() => false);
      const oldExists = await fs
        .stat(oldFile.path)
        .then(() => true)
        .catch(() => false);
      expect(newExists).toBe(true);
      expect(oldExists).toBe(false);
    });

    it("ベースディレクトリがなくてもエラーにならない", async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
      await expect(manager.cleanup()).resolves.toBe(0);
    });
  });
});
