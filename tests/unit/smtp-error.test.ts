import { describe, it, expect } from "vitest";
import { classifySmtpError } from "../../src/main/services/send.service";

describe("smtp error classification (P1-2)", () => {
  const transient = [
    "connect ETIMEDOUT 1.2.3.4:587",
    "read ECONNRESET",
    "connect ECONNREFUSED 0.0.0.0:465",
    "getaddrinfo EAI_AGAIN smtp.example.com",
    "write EPIPE",
    "450 4.2.0 Greylisted, try again later",
    "451 4.3.0 Temporary local problem",
    "421 Service unavailable, try later",
    "452 4.2.2 Mailbox full (temporary)",
    "Server busy, try again",
  ];
  const permanent = [
    "535 Authentication failed",
    "550 5.1.1 recipient rejected",
    "Invalid login: bad credentials",
    "554 Message rejected for spam content",
    "",
    "unknown error",
  ];

  it("网络栈错误码与服务端临时拒绝判为瞬态", () => {
    for (const m of transient) expect(classifySmtpError(m), m).toBe("transient");
  });

  it("认证失败/拒收/垃圾邮件判定等判为永久", () => {
    for (const m of permanent) expect(classifySmtpError(m), m || "(empty)").toBe("permanent");
  });

  it("大小写不敏感", () => {
    expect(classifySmtpError("Connect ETIMEDOUT")).toBe("transient");
    expect(classifySmtpError("AUTHENTICATION FAILED")).toBe("permanent");
  });
});
