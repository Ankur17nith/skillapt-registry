import type { R2Bucket, R2Object, R2ObjectBody, R2PutOptions } from "@cloudflare/workers-types";

export class MockR2Bucket {
  private store = new Map<string, Uint8Array>();

  public async get(key: string): Promise<R2ObjectBody | null> {
    const data = this.store.get(key);
    if (!data) return null;

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(data);
        controller.close();
      }
    });

    const body: Partial<R2ObjectBody> = {
      key,
      size: data.byteLength,
      etag: "mock-etag",
      uploaded: new Date(),
      httpMetadata: {
        contentType: "application/gzip"
      },
      body: stream as any,
      async arrayBuffer(): Promise<ArrayBuffer> {
        const copy = new Uint8Array(data.byteLength);
        copy.set(data);
        return copy.buffer as ArrayBuffer;
      },
      async text(): Promise<string> {
        return new TextDecoder().decode(data);
      }
    };

    return body as R2ObjectBody;
  }

  public async put(key: string, value: ArrayBuffer | Uint8Array | string | ReadableStream, _options?: R2PutOptions): Promise<R2Object> {
    let bytes: Uint8Array;
    if (typeof value === "string") {
      bytes = new TextEncoder().encode(value);
    } else if (value instanceof Uint8Array) {
      bytes = value;
    } else if (value instanceof ArrayBuffer) {
      bytes = new Uint8Array(value);
    } else {
      // ReadableStream
      const reader = (value as ReadableStream<Uint8Array>).getReader();
      const chunks: Uint8Array[] = [];
      let done = false;
      while (!done) {
        const item = await reader.read();
        if (item.value) chunks.push(item.value);
        done = item.done;
      }
      const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
      bytes = new Uint8Array(totalLen);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
    }

    this.store.set(key, bytes);

    return {
      key,
      size: bytes.byteLength,
      etag: "mock-etag",
      uploaded: new Date()
    } as R2Object;
  }

  public async delete(key: string | string[]): Promise<void> {
    if (Array.isArray(key)) {
      for (const k of key) this.store.delete(k);
    } else {
      this.store.delete(key);
    }
  }

  public asR2(): R2Bucket {
    return this as unknown as R2Bucket;
  }
}
