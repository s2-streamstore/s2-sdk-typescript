const textEncoder = new TextEncoder();

export const FRAME_BYTES_HEADER = "_frame_bytes";
export const FRAME_RECORDS_HEADER = "_frame_records";
export const DEDUPE_SEQ_HEADER = "_dedupe_seq";
export const WRITER_UNIQ_ID = "_writer_id";

export const FRAME_BYTES_HEADER_BYTES = textEncoder.encode(FRAME_BYTES_HEADER);
export const FRAME_RECORDS_HEADER_BYTES =
	textEncoder.encode(FRAME_RECORDS_HEADER);
export const DEDUPE_SEQ_HEADER_BYTES = textEncoder.encode(DEDUPE_SEQ_HEADER);

export const DEDUPE_WRITER_UNIQ_ID = textEncoder.encode(WRITER_UNIQ_ID);
