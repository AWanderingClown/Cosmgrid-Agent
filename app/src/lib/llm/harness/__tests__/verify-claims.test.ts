import { describe, it, expect } from "vitest";
import { verifyFileClaims, unverifiedClaims, type ReadRecord } from "../verify-claims";

const readRec = (file_path: string, status = "success"): ReadRecord => ({
  input: JSON.stringify({ file_path }),
  status,
});

describe("verifyFileClaims", () => {
  it("声称的路径在 read 记录里 → verified", () => {
    const out = verifyFileClaims(["/tmp/test.txt"], [readRec("/tmp/test.txt")]);
    expect(out[0]?.verified).toBe(true);
  });

  it("声称的路径不在 read 记录里 → 未验证（编的）", () => {
    const out = verifyFileClaims(["/tmp/fake.txt"], [readRec("/tmp/real.txt")]);
    expect(out[0]?.verified).toBe(false);
    expect(out[0]?.reason).toContain("编造");
  });

  it("相对路径 vs 绝对路径能匹配（模型说 app/db.ts，实际读了 /workspace/app/db.ts）", () => {
    const out = verifyFileClaims(["app/src/db.ts"], [readRec("/workspace/app/src/db.ts")]);
    expect(out[0]?.verified).toBe(true);
  });

  it("basename 相同且带扩展名能匹配", () => {
    const out = verifyFileClaims(["pkg.json"], [readRec("/abs/pkg.json")]);
    expect(out[0]?.verified).toBe(true);
  });

  it("denied/error 状态的 read 不算读过（没真拿到内容）", () => {
    const out = verifyFileClaims(["/tmp/x.txt"], [readRec("/tmp/x.txt", "denied")]);
    expect(out[0]?.verified).toBe(false);
  });

  it("空 read 记录 → 全部未验证", () => {
    const out = verifyFileClaims(["/a.txt", "/b.ts"], []);
    expect(out.every((c) => !c.verified)).toBe(true);
  });
});

describe("unverifiedClaims", () => {
  it("只返回未验证的", () => {
    const claims = verifyFileClaims(
      ["/ok.txt", "/fake.txt", "/ok2.ts"],
      [readRec("/ok.txt"), readRec("/ok2.ts")],
    );
    const uv = unverifiedClaims(claims);
    expect(uv).toHaveLength(1);
    expect(uv[0]?.claimed).toBe("/fake.txt");
  });
});
