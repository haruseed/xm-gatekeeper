const MAX_BODY_BYTES = 131_072;

/** Bound upload time and bytes before reserving expensive challenge slots. */
export async function readCapBody(req: Request, timeoutMs = 5000): Promise<unknown> {
  if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) {
    throw new Error('body_too_large');
  }
  const reader = req.body?.getReader();
  if (!reader) return {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = async () => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) throw new Error('body_too_large');
      chunks.push(value);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    return raw ? JSON.parse(raw) : {};
  };
  try {
    return await Promise.race([
      read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('body_timeout')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => undefined);
  }
}
