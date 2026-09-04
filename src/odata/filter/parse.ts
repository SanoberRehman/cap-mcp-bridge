/**
 * Recursive-descent parser for the subset of OData v4 `$filter` that models realistically emit:
 * comparisons, and/or/not, parentheses, `in`, and function calls.
 *
 * Anything it cannot parse is rejected with the position, rather than forwarded to the service to
 * fail with an opaque 400.
 */

import type { ComparisonOp, Expr, FilterNode } from "./ast.js";
import { F } from "./ast.js";
import { ValidationError } from "../../util/errors.js";

type Token =
  | { t: "lparen" | "rparen" | "comma"; pos: number }
  | { t: "string"; value: string; pos: number }
  | { t: "number"; value: number; pos: number }
  | { t: "word"; value: string; pos: number }
  | { t: "enum"; type: string; member: string; pos: number }
  | { t: "eof"; pos: number };

const KEYWORDS = new Set(["and", "or", "not", "eq", "ne", "gt", "ge", "lt", "le", "in", "true", "false", "null"]);
const CMP_OPS = new Set<string>(["eq", "ne", "gt", "ge", "lt", "le"]);

function fail(message: string, pos: number, input: string): never {
  throw new ValidationError({
    code: "filter_parse_error",
    message: `Could not parse $filter at position ${pos}: ${message}. Input: ${input}`,
    hint: "Prefer the structured filter form: { field, op, value } combined with and / or / not. It never needs quoting.",
  });
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i] ?? "";
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    if (c === "(") {
      tokens.push({ t: "lparen", pos: i });
      i += 1;
      continue;
    }
    if (c === ")") {
      tokens.push({ t: "rparen", pos: i });
      i += 1;
      continue;
    }
    if (c === ",") {
      tokens.push({ t: "comma", pos: i });
      i += 1;
      continue;
    }
    if (c === "'") {
      const start = i;
      let value = "";
      i += 1;
      for (;;) {
        if (i >= input.length) fail("unterminated string literal", start, input);
        const ch = input[i] ?? "";
        if (ch === "'") {
          if (input[i + 1] === "'") {
            value += "'";
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        value += ch;
        i += 1;
      }
      tokens.push({ t: "string", value, pos: start });
      continue;
    }
    // Number (including negative and decimals), but not a date/guid which continue with '-' or letters.
    const numMatch = /^-?\d+(\.\d+)?(?![\w:.-])/.exec(input.slice(i));
    if (numMatch) {
      tokens.push({ t: "number", value: Number(numMatch[0]), pos: i });
      i += numMatch[0].length;
      continue;
    }
    // Word: identifiers, paths, bare literals (dates, guids), qualified names.
    const wordMatch = /^[A-Za-z0-9_@$][A-Za-z0-9_.:/+-]*/.exec(input.slice(i));
    if (wordMatch) {
      const word = wordMatch[0];
      const start = i;
      i += word.length;
      // Enum literal: Namespace.Type'Member'
      if (input[i] === "'" && word.includes(".")) {
        const end = input.indexOf("'", i + 1);
        if (end < 0) fail("unterminated enum literal", start, input);
        tokens.push({ t: "enum", type: word, member: input.slice(i + 1, end), pos: start });
        i = end + 1;
        continue;
      }
      tokens.push({ t: "word", value: word, pos: start });
      continue;
    }
    fail(`unexpected character "${c}"`, i, input);
  }
  tokens.push({ t: "eof", pos: input.length });
  return tokens;
}

class Parser {
  private i = 0;
  constructor(
    private readonly tokens: Token[],
    private readonly input: string,
  ) {}

  parse(): FilterNode {
    const node = this.orExpr();
    const tok = this.peek();
    if (tok.t !== "eof") this.error(`unexpected ${describe(tok)}`, tok.pos);
    return node;
  }

  private peek(): Token {
    return this.tokens[this.i] ?? { t: "eof", pos: this.input.length };
  }

  private next(): Token {
    const tok = this.peek();
    this.i += 1;
    return tok;
  }

  private isWord(value: string): boolean {
    const tok = this.peek();
    return tok.t === "word" && tok.value.toLowerCase() === value;
  }

  private expect(t: Token["t"], what: string): Token {
    const tok = this.next();
    if (tok.t !== t) this.error(`expected ${what} but found ${describe(tok)}`, tok.pos);
    return tok;
  }

  private error(message: string, pos: number): never {
    fail(message, pos, this.input);
  }

  private orExpr(): FilterNode {
    const parts = [this.andExpr()];
    while (this.isWord("or")) {
      this.next();
      parts.push(this.andExpr());
    }
    return parts.length === 1 ? (parts[0] as FilterNode) : F.or(...parts);
  }

  private andExpr(): FilterNode {
    const parts = [this.notExpr()];
    while (this.isWord("and")) {
      this.next();
      parts.push(this.notExpr());
    }
    return parts.length === 1 ? (parts[0] as FilterNode) : F.and(...parts);
  }

  private notExpr(): FilterNode {
    if (this.isWord("not")) {
      this.next();
      return F.not(this.notExpr());
    }
    return this.comparison();
  }

  private comparison(): FilterNode {
    // Parenthesised boolean expression vs. parenthesised operand: try boolean first.
    if (this.peek().t === "lparen") {
      const save = this.i;
      this.next();
      try {
        const inner = this.orExpr();
        this.expect("rparen", "')'");
        // If a comparison operator follows, the parenthesised thing was an operand, not a condition.
        if (this.peekIsComparisonOp()) {
          this.i = save;
        } else {
          return inner;
        }
      } catch {
        this.i = save;
      }
    }

    const left = this.operand();
    const tok = this.peek();
    if (tok.t === "word" && CMP_OPS.has(tok.value.toLowerCase())) {
      this.next();
      const right = this.operand();
      return F.cmp(tok.value.toLowerCase() as ComparisonOp, left, right);
    }
    if (tok.t === "word" && tok.value.toLowerCase() === "in") {
      this.next();
      this.expect("lparen", "'(' after in");
      const values: Expr[] = [];
      if (this.peek().t !== "rparen") {
        values.push(this.operand());
        while (this.peek().t === "comma") {
          this.next();
          values.push(this.operand());
        }
      }
      this.expect("rparen", "')' closing the in-list");
      return F.in(left, values);
    }
    if (left.kind === "lit") this.error("a literal cannot stand alone as a condition", tok.pos);
    return F.bool(left);
  }

  private peekIsComparisonOp(): boolean {
    const tok = this.peek();
    return tok.t === "word" && (CMP_OPS.has(tok.value.toLowerCase()) || tok.value.toLowerCase() === "in");
  }

  private operand(): Expr {
    const tok = this.next();
    switch (tok.t) {
      case "string":
        return F.lit(tok.value, true);
      case "number":
        return F.lit(tok.value, false);
      case "enum":
        return { kind: "lit", value: tok.member, quoted: true, enumType: tok.type };
      case "lparen": {
        const inner = this.operand();
        this.expect("rparen", "')'");
        return inner;
      }
      case "word": {
        const lower = tok.value.toLowerCase();
        if (lower === "true") return F.lit(true, false);
        if (lower === "false") return F.lit(false, false);
        if (lower === "null") return F.lit(null, false);
        if (KEYWORDS.has(lower)) this.error(`unexpected keyword "${tok.value}"`, tok.pos);
        if (this.peek().t === "lparen") {
          this.next();
          const args: Expr[] = [];
          if (this.peek().t !== "rparen") {
            args.push(this.operand());
            while (this.peek().t === "comma") {
              this.next();
              args.push(this.operand());
            }
          }
          this.expect("rparen", `')' closing ${tok.value}(...)`);
          return F.call(lower, ...args);
        }
        // Bare word: a field path, or an unquoted literal such as a date or GUID.
        if (/^\d/.test(tok.value)) return F.lit(tok.value, false);
        return F.field(tok.value);
      }
      default:
        this.error(`expected a field, literal or function but found ${describe(tok)}`, tok.pos);
    }
  }
}

function describe(tok: Token): string {
  switch (tok.t) {
    case "eof":
      return "end of input";
    case "lparen":
      return "'('";
    case "rparen":
      return "')'";
    case "comma":
      return "','";
    case "string":
      return `string '${tok.value}'`;
    case "number":
      return `number ${tok.value}`;
    case "enum":
      return `enum ${tok.type}'${tok.member}'`;
    case "word":
      return `"${tok.value}"`;
  }
}

/** Parse a raw `$filter` string into the shared AST. Throws ValidationError on syntax errors. */
export function parseFilter(input: string): FilterNode {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new ValidationError({ code: "filter_parse_error", message: "$filter is empty" });
  }
  return new Parser(tokenize(trimmed), trimmed).parse();
}
