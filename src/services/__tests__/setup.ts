import { Blob, File } from 'node:buffer'
import { vi } from 'vitest'

// jsdom does not implement Blob.arrayBuffer; Node 24 implements the browser binary APIs used by archives.
vi.stubGlobal('Blob', Blob)
vi.stubGlobal('File', File)

vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 0))
vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id))
