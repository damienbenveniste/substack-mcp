export interface SubstackClientConfig {
  readonly publicationUrl: string;
  readonly sessionToken: string;
  readonly userId: number;
  readonly userAgent: string;
  readonly requestTimeoutMs?: number | undefined;
}

export interface SubstackDraftSummary {
  readonly id: number;
  readonly title?: string | undefined;
  readonly subtitle?: string | undefined;
  readonly audience?: string | undefined;
  readonly word_count?: number | undefined;
  readonly created_at?: string | undefined;
  readonly updated_at?: string | undefined;
  readonly url?: string | undefined;
}

export interface SubstackDraft extends SubstackDraftSummary {
  readonly body?: unknown;
  readonly draft_body?: unknown;
  readonly status?: string | undefined;
  readonly draft?: boolean | undefined;
  readonly is_draft?: boolean | undefined;
  readonly post_date?: string | null | undefined;
  readonly published_at?: string | null | undefined;
  readonly is_published?: boolean | undefined;
  readonly raw: unknown;
}

export interface DraftCreatePayload {
  readonly draft_title: string;
  readonly draft_subtitle?: string | undefined;
  readonly draft_body: string;
  readonly draft_bylines: readonly DraftByline[];
  readonly audience?: string | undefined;
  readonly type: "newsletter";
}

export interface DraftUpdatePayload {
  readonly draft_title?: string | undefined;
  readonly draft_subtitle?: string | undefined;
  readonly draft_body?: string | undefined;
  readonly audience?: string | undefined;
  readonly type?: "newsletter" | undefined;
}

export interface DraftByline {
  readonly id: number;
  readonly is_guest: boolean;
}

export interface UploadedImage {
  readonly url: string;
}

export interface SubstackAuthValidation {
  readonly id: number;
  readonly ok: true;
}

export type FetchRedirectMode = "error" | "follow" | "manual";

export type FetchLike = (
  input: string | URL,
  init?: {
    readonly method?: string;
    readonly headers?: Headers | Readonly<Record<string, string>>;
    readonly body?: string;
    readonly redirect?: FetchRedirectMode;
    readonly signal?: AbortSignal;
  },
) => Promise<Response>;
