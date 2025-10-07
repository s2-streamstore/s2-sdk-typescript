export type S2ClientOptions = {
	accessToken: string;
};

export type S2RequestOptions = {
	signal?: AbortSignal;
};

export type DataToObject<T> = (T extends { body: infer B } ? B : {}) &
	(T extends { path: infer P } ? P : {}) &
	(T extends { query: infer Q } ? Q : {});
