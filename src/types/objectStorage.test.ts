import { describe, expect, it } from "vitest";
import { normalizeObjectStorageConfig, type ObjectStorageConfig } from "./objectStorage";

function base(provider: ObjectStorageConfig["provider"], endpoint: string): ObjectStorageConfig {
  return {
    provider,
    endpoint,
    region: "ap-beijing",
    accessKeyId: "key",
    secretAccessKey: "secret",
  };
}

describe("normalizeObjectStorageConfig", () => {
  it("infers a Tencent COS bucket endpoint", () => {
    const cfg = normalizeObjectStorageConfig(
      base("tencent-cos", "https://photos-1234567890.cos.ap-beijing.myqcloud.com"),
    );

    expect(cfg.endpoint).toBe("https://cos.ap-beijing.myqcloud.com/");
    expect(cfg.defaultBucket).toBe("photos-1234567890");
  });

  it("infers an Alibaba OSS bucket endpoint", () => {
    const cfg = normalizeObjectStorageConfig(
      base("alibaba-oss", "archive.oss-cn-hangzhou.aliyuncs.com"),
    );

    expect(cfg.endpoint).toBe("https://oss-cn-hangzhou.aliyuncs.com/");
    expect(cfg.defaultBucket).toBe("archive");
  });

  it("keeps an explicitly configured default bucket", () => {
    const cfg = normalizeObjectStorageConfig({
      ...base("tencent-cos", "https://endpoint-bucket.cos.ap-beijing.myqcloud.com"),
      defaultBucket: "configured-bucket",
    });

    expect(cfg.endpoint).toBe("https://cos.ap-beijing.myqcloud.com/");
    expect(cfg.defaultBucket).toBe("configured-bucket");
  });

  it("leaves service endpoints unchanged", () => {
    const cfg = normalizeObjectStorageConfig(
      base("tencent-cos", "https://cos.ap-beijing.myqcloud.com"),
    );

    expect(cfg.endpoint).toBe("https://cos.ap-beijing.myqcloud.com");
    expect(cfg.defaultBucket).toBeUndefined();
  });
});
