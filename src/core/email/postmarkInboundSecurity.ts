export interface PostmarkHeader {
  Name: string;
  Value: string;
}

export interface PostmarkInboundSecurityVerdict {
  senderAuthenticated: boolean;
  spamSafe: boolean;
}

function uniqueHeader(headers: PostmarkHeader[], name: string): string | null {
  const values = headers
    .filter((header) => header.Name.toLowerCase() === name.toLowerCase())
    .map((header) => header.Value.trim());
  return values.length === 1 && values[0] ? values[0] : null;
}

function spamTests(value: string | null): Set<string> {
  return new Set(
    (value ?? "")
      .split(/[\s,]+/)
      .map((token) => token.trim().toUpperCase())
      .filter(Boolean),
  );
}

/**
 * Convert Postmark's SpamAssassin headers into fail-closed verdicts at the
 * authenticated webhook boundary. Duplicate or incomplete verdict headers
 * are rejected so message-supplied lookalikes cannot win by ordering.
 */
export function assessPostmarkInboundSecurity(
  headers: PostmarkHeader[],
): PostmarkInboundSecurityVerdict {
  const receivedSpf = uniqueHeader(headers, "Received-SPF");
  const tests = spamTests(uniqueHeader(headers, "X-Spam-Tests"));
  const spamStatus = uniqueHeader(headers, "X-Spam-Status");
  const spamScoreValue = uniqueHeader(headers, "X-Spam-Score");
  const spamScore = spamScoreValue === null ? Number.NaN : Number(spamScoreValue);

  return {
    senderAuthenticated:
      receivedSpf !== null
      && /^pass\b/i.test(receivedSpf)
      && tests.has("SPF_PASS")
      && tests.has("DKIM_VALID_AU"),
    spamSafe:
      spamStatus !== null
      && /^no\b/i.test(spamStatus)
      && Number.isFinite(spamScore)
      && spamScore < 5,
  };
}
