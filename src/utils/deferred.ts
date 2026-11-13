/** Promise.withResolvers for the supported pre-2024 browser baseline as well as modern hosts. */
export const deferred = <T>(): PromiseWithResolvers<T> => {
  if (typeof Promise.withResolvers === 'function') return Promise.withResolvers<T>()
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  // This is the constructor API required to implement the missing native method.
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject })
  return { promise, resolve, reject }
}
