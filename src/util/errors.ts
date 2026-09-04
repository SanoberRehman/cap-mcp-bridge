/**
 * Errors are structured so the tool layer can hand a model something it can act on:
 * what was wrong, and what the valid options were.
 */

export interface StructuredErrorDetails {
  /** Machine-readable code, e.g. `unknown_field`, `not_filterable`, `odata_error`. */
  code: string;
  /** Human message. Always names the offending thing. */
  message: string;
  /** The entity set / field / operation the error is about. */
  target?: string;
  /** Valid alternatives when the input was close but wrong. */
  validOptions?: string[];
  /** Extra hint for the caller. */
  hint?: string;
}

export class BridgeError extends Error {
  readonly code: string;
  readonly target: string | undefined;
  readonly validOptions: string[] | undefined;
  readonly hint: string | undefined;

  constructor(details: StructuredErrorDetails) {
    super(details.message);
    this.name = "BridgeError";
    this.code = details.code;
    this.target = details.target;
    this.validOptions = details.validOptions;
    this.hint = details.hint;
  }

  toJSON(): StructuredErrorDetails {
    const out: StructuredErrorDetails = { code: this.code, message: this.message };
    if (this.target !== undefined) out.target = this.target;
    if (this.validOptions !== undefined) out.validOptions = this.validOptions;
    if (this.hint !== undefined) out.hint = this.hint;
    return out;
  }
}

/** Validation failure before any network call is made. */
export class ValidationError extends BridgeError {
  constructor(details: StructuredErrorDetails) {
    super(details);
    this.name = "ValidationError";
  }
}

/** The remote service answered with an error. */
export class ODataError extends BridgeError {
  readonly status: number;
  readonly odataCode: string | undefined;

  constructor(status: number, message: string, odataCode?: string, hint?: string) {
    super({
      code: "odata_error",
      message,
      ...(hint !== undefined ? { hint } : {}),
    });
    this.name = "ODataError";
    this.status = status;
    this.odataCode = odataCode;
  }

  override toJSON(): StructuredErrorDetails & { status: number; odataCode?: string } {
    return {
      ...super.toJSON(),
      status: this.status,
      ...(this.odataCode !== undefined ? { odataCode: this.odataCode } : {}),
    };
  }
}

export class UnsupportedODataVersionError extends BridgeError {
  constructor(detected: string) {
    super({
      code: "unsupported_odata_version",
      message:
        `This service speaks OData ${detected}. cap-mcp-bridge supports OData v4 only. ` +
        `For CAP services, use the v4 endpoint (usually /odata/v4/<service>), which is the default protocol in CAP.`,
    });
    this.name = "UnsupportedODataVersionError";
  }
}

export class ConfigError extends BridgeError {
  constructor(message: string, hint?: string) {
    super({ code: "config_error", message, ...(hint !== undefined ? { hint } : {}) });
    this.name = "ConfigError";
  }
}

/** Serialise any thrown value into the structured shape returned to the model. */
export function toStructuredError(err: unknown): StructuredErrorDetails {
  if (err instanceof BridgeError) return err.toJSON();
  if (err instanceof Error) {
    const name = err.name === "AbortError" || err.name === "TimeoutError" ? "timeout" : "internal_error";
    return { code: name, message: err.message };
  }
  return { code: "internal_error", message: String(err) };
}
