export interface PromiseResolver<T> {
	promise: Promise<T>;
	resolve(value: T | PromiseLike<T>): void;
	reject(reason?: unknown): void;
}

const promiseConstructor = Promise as PromiseConstructor & {
	withResolvers<T>(): PromiseResolver<T>;
};

/** Keeps Promise.withResolvers usable when a consumer's TypeScript lib omits PromiseWithResolvers. */
export function withResolvers<T>(): PromiseResolver<T> {
	return promiseConstructor.withResolvers<T>();
}
