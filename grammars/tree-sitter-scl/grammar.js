// SPDX-License-Identifier: MIT
// tree-sitter grammar for Siemens SCL (IEC 61131-3 Structured Text dialect used by TIA Portal), and the
// IEC 61131-3 structured text of TwinCAT and CODESYS (PROGRAM, METHOD, bodies without BEGIN, enumerations).
// Written for rung (https://github.com/sa1ntsinner/rung). Keywords are case-insensitive.

/** Case-insensitive keyword token that wins over identifiers. */
function kw(word) {
  const pattern = word
    .split("")
    .map((c) => (/[a-z]/i.test(c) ? `[${c.toLowerCase()}${c.toUpperCase()}]` : c))
    .join("");
  return alias(token(prec(2, new RegExp(pattern))), word.toUpperCase());
}

const PREC = { or: 1, xor: 2, and: 3, compare: 4, add: 5, mul: 6, power: 7, unary: 8, postfix: 9 };

module.exports = grammar({
  name: "scl",

  extras: ($) => [/\s/, $.line_comment, $.block_comment],

  word: ($) => $.identifier,

  conflicts: ($) => [[$.case_item]],

  rules: {
    source_file: ($) => repeat(choice($._block, $.pragma, $.var_section)),

    _block: ($) => choice($.function_block, $.function, $.organization_block, $.data_block, $.type_definition, $.program, $.method, $.property, $.interface),

    // SCL bodies start with BEGIN; IEC POUs start their statements right after the declarations
    _code: ($) => choice($.body, alias($._iec_body, $.body)),
    _iec_body: ($) => repeat1($._statement),
    _modifier: (_) => choice(kw("ABSTRACT"), kw("FINAL"), kw("PUBLIC"), kw("PRIVATE"), kw("PROTECTED"), kw("INTERNAL")),
    extends: ($) => seq(kw("EXTENDS"), commaSep1($._name)),
    implements: ($) => seq(kw("IMPLEMENTS"), commaSep1($._name)),

    function_block: ($) =>
      seq(kw("FUNCTION_BLOCK"), repeat($._modifier), field("name", $._name), optional($.extends), optional($.implements), repeat($._block_header), repeat($.var_section), optional($._code), kw("END_FUNCTION_BLOCK")),
    function: ($) =>
      seq(kw("FUNCTION"), field("name", $._name), optional(seq(":", field("return_type", $._type))), repeat($._block_header), repeat($.var_section), optional($._code), kw("END_FUNCTION")),
    program: ($) => seq(kw("PROGRAM"), field("name", $._name), repeat($._block_header), repeat($.var_section), optional($._code), kw("END_PROGRAM")),
    method: ($) =>
      seq(kw("METHOD"), repeat($._modifier), field("name", $._name), optional(seq(":", field("return_type", $._type))), repeat($._block_header), repeat($.var_section), optional($._code), kw("END_METHOD")),
    // CODESYS / TwinCAT: GET … END_GET and SET … END_SET, each with its own variables; an interface property has none
    property: ($) =>
      seq(kw("PROPERTY"), repeat($._modifier), field("name", $._name), ":", field("type", $._type), repeat($.var_section), choice(repeat1($.property_accessor), optional($._code)), kw("END_PROPERTY")),
    property_accessor: ($) => seq(field("kind", choice(kw("GET"), kw("SET"))), repeat($.var_section), optional($._code), choice(kw("END_GET"), kw("END_SET"))),
    interface: ($) => seq(kw("INTERFACE"), field("name", $._name), optional($.extends), repeat(choice($.method, $.property)), kw("END_INTERFACE")),
    organization_block: ($) => seq(kw("ORGANIZATION_BLOCK"), field("name", $._name), repeat($._block_header), repeat($.var_section), optional($.body), kw("END_ORGANIZATION_BLOCK")),
    data_block: ($) =>
      seq(kw("DATA_BLOCK"), field("name", $._name), repeat($._block_header), choice(repeat1($.var_section), field("of", $.global_name), seq()), optional($.db_body), kw("END_DATA_BLOCK")),
    type_definition: ($) =>
      seq(
        kw("TYPE"),
        field("name", $._name),
        optional($.extends),
        optional(":"),
        repeat($._block_header),
        choice($.enum_type, $._type),
        optional(seq(":=", field("value", $._initializer))),
        optional(";"),
        kw("END_TYPE"),
      ),
    // IEC enumeration: (Idle := 0, Running, Fault := 16#FF) INT
    enum_type: ($) => seq("(", commaSep1($.enum_value), ")", optional(field("base", $.identifier))),
    enum_value: ($) => seq(field("name", $.identifier), optional(seq(":=", field("value", $._expression)))),

    _name: ($) => choice($.global_name, $.identifier),

    _block_header: ($) => choice($.pragma, $.title, $.version, $.header_attribute, kw("NON_RETAIN"), kw("KNOW_HOW_PROTECT"), kw("READ_ONLY"), kw("UNLINKED")),
    title: ($) => seq(kw("TITLE"), "=", /[^\r\n]*/),
    version: ($) => seq(kw("VERSION"), ":", /[0-9.]+/),
    header_attribute: ($) => seq(choice(kw("AUTHOR"), kw("FAMILY"), kw("NAME")), ":", /[^\r\n]*/),

    var_section: ($) =>
      seq(
        field(
          "kind",
          choice(kw("VAR_INPUT"), kw("VAR_OUTPUT"), kw("VAR_IN_OUT"), kw("VAR_TEMP"), kw("VAR_STAT"), kw("VAR_GLOBAL"), kw("VAR_INST"), kw("VAR_EXTERNAL"), kw("VAR_CONFIG"), kw("VAR")),
        ),
        repeat(choice(kw("CONSTANT"), kw("RETAIN"), kw("NON_RETAIN"), kw("PERSISTENT"), kw("DB_SPECIFIC"))),
        repeat($.var_declaration),
        kw("END_VAR"),
      ),

    var_declaration: ($) =>
      seq(
        commaSep1(field("name", choice($.identifier, $.global_name))),
        repeat($.pragma),
        optional(seq(kw("AT"), choice($.identifier, $.absolute_address))),
        ":",
        field("type", $._type),
        optional(seq(":=", field("value", $._initializer))),
        ";",
      ),

    _initializer: ($) => choice($._expression, $.array_initializer),
    array_initializer: ($) => seq("[", commaSep1(choice($._expression, seq($._expression, "(", $._expression, ")"))), "]"),

    _type: ($) => choice($.array_type, $.struct_type, $.string_type, $.pointer_type, $.global_name, $.identifier),
    // IEC: POINTER TO INT, REFERENCE TO ST_X; SCL: REF_TO Int
    pointer_type: ($) => choice(seq(choice(kw("POINTER"), kw("REFERENCE")), kw("TO"), $._type), seq(kw("REF_TO"), $._type)),
    array_type: ($) => seq(kw("ARRAY"), "[", commaSep1($.range), "]", kw("OF"), $._type),
    range: ($) => seq($._expression, "..", $._expression),
    struct_type: ($) => seq(kw("STRUCT"), repeat($.var_declaration), kw("END_STRUCT")),
    string_type: ($) => seq(choice(kw("STRING"), kw("WSTRING")), choice(seq("[", $._expression, "]"), seq("(", $._expression, ")"))),

    body: ($) => seq(kw("BEGIN"), repeat($._statement)),
    db_body: ($) => seq(kw("BEGIN"), repeat($.assignment_statement)),

    _statement: ($) =>
      choice(
        $.assignment_statement,
        $.call_statement,
        $.if_statement,
        $.case_statement,
        $.for_statement,
        $.while_statement,
        $.repeat_statement,
        $.region,
        $.exit_statement,
        $.continue_statement,
        $.return_statement,
        $.goto_statement,
        $.label,
        $.empty_statement,
      ),

    // := ; ?= assignment attempt; IEC S= / R= (set / reset) and REF= (bind a reference)
    assignment_statement: ($) => seq(field("left", $._lvalue), field("operator", choice(":=", "?=", $.set_reset, $.ref_bind)), field("right", $._expression), ";"),
    set_reset: (_) => token(prec(3, /[sSrR]=/)),
    ref_bind: (_) => token(prec(3, /[rR][eE][fF]=/)),
    call_statement: ($) => seq($.call_expression, ";"),
    empty_statement: (_) => ";",
    exit_statement: (_) => seq(kw("EXIT"), ";"),
    continue_statement: (_) => seq(kw("CONTINUE"), ";"),
    return_statement: (_) => seq(kw("RETURN"), ";"),
    goto_statement: ($) => seq(kw("GOTO"), $.identifier, ";"),
    label: ($) => seq(field("name", $.identifier), ":"),

    if_statement: ($) =>
      seq(kw("IF"), field("condition", $._expression), kw("THEN"), repeat($._statement), repeat($.elsif_clause), optional($.else_clause), kw("END_IF")),
    elsif_clause: ($) => seq(kw("ELSIF"), $._expression, kw("THEN"), repeat($._statement)),
    else_clause: ($) => seq(kw("ELSE"), repeat($._statement)),

    case_statement: ($) => seq(kw("CASE"), field("selector", $._expression), kw("OF"), repeat($.case_item), optional($.else_clause), kw("END_CASE")),
    case_item: ($) => seq(commaSep1($.case_label), ":", repeat($._statement)),
    case_label: ($) => choice($.range, $.number, $.typed_literal, $.identifier, $.member_expression, seq("-", $.number)),

    for_statement: ($) =>
      seq(kw("FOR"), field("variable", $._lvalue), ":=", $._expression, kw("TO"), $._expression, optional(seq(kw("BY"), $._expression)), kw("DO"), repeat($._statement), kw("END_FOR")),
    while_statement: ($) => seq(kw("WHILE"), $._expression, kw("DO"), repeat($._statement), kw("END_WHILE")),
    repeat_statement: ($) => seq(kw("REPEAT"), repeat($._statement), kw("UNTIL"), $._expression, kw("END_REPEAT")),

    region: ($) => seq(field("header", $.region_header), repeat($._statement), kw("END_REGION")),
    region_header: (_) => token(prec(3, /[rR][eE][gG][iI][oO][nN]([ \t][^\r\n]*)?/)),

    _lvalue: ($) => choice($.local_variable, $.global_name, $.identifier, $.member_expression, $.index_expression, $.deref_expression, $.absolute_address),

    _expression: ($) =>
      choice(
        $.local_variable,
        $.global_name,
        $.identifier,
        $.absolute_address,
        $.number,
        $.typed_literal,
        $.string,
        $.boolean,
        $.member_expression,
        $.index_expression,
        $.deref_expression,
        $.call_expression,
        $.parenthesized_expression,
        $.unary_expression,
        $.binary_expression,
      ),

    parenthesized_expression: ($) => seq("(", $._expression, ")"),
    unary_expression: ($) => prec(PREC.unary, seq(field("operator", choice(kw("NOT"), "-", "+")), $._expression)),
    binary_expression: ($) => {
      const table = [
        [PREC.or, kw("OR")],
        [PREC.xor, kw("XOR")],
        [PREC.and, choice(kw("AND"), "&")],
        [PREC.compare, choice("=", "<>", "<", ">", "<=", ">=")],
        [PREC.add, choice("+", "-")],
        [PREC.mul, choice("*", "/", kw("MOD"))],
      ];
      return choice(
        ...table.map(([p, op]) => prec.left(p, seq(field("left", $._expression), field("operator", op), field("right", $._expression)))),
        prec.right(PREC.power, seq(field("left", $._expression), field("operator", "**"), field("right", $._expression))),
      );
    },
    member_expression: ($) => prec(PREC.postfix, seq(field("object", $._expression), ".", field("member", choice($.identifier, $.global_name, $.local_variable, $.number)))),
    index_expression: ($) => prec(PREC.postfix, seq(field("object", $._expression), "[", commaSep1($._expression), "]")),
    // IEC: p^, THIS^.x
    deref_expression: ($) => prec(PREC.postfix, seq(field("object", $._expression), "^")),
    call_expression: ($) => prec(PREC.postfix, seq(field("function", choice($.identifier, $.global_name, $.local_variable, $.member_expression)), "(", optional(commaSep1($.argument)), ")")),
    argument: ($) => choice(seq(field("name", $.identifier), choice(":=", "=>"), field("value", $._expression)), $._expression),

    local_variable: (_) => token(seq("#", choice(/[A-Za-z_À-￿][A-Za-z0-9_À-￿]*/, /"[^"\r\n]*"/))),
    global_name: (_) => token(seq('"', /[^"\r\n]*/, '"')),
    absolute_address: (_) => token(seq("%", /[A-Za-z][A-Za-z0-9_.]*\*?/)),
    identifier: (_) => /[A-Za-z_À-￿][A-Za-z0-9_À-￿]*/,
    boolean: (_) => choice(kw("TRUE"), kw("FALSE")),
    number: (_) => token(choice(/[0-9][0-9_]*(\.[0-9][0-9_]*)?([eE][+-]?[0-9]+)?/, /(2|8|16)#[0-9A-Fa-f_]+/)),
    typed_literal: (_) => token(prec(1, seq(/[A-Za-z_]+/, "#", /[-+]?[A-Za-z0-9_.:\-]+/))),
    string: (_) => token(seq("'", repeat(choice(/[^'$\r\n]/, /\$./, "''")), "'")),
    pragma: (_) => token(seq("{", /[^}]*/, "}")),
    line_comment: (_) => token(seq("//", /[^\r\n]*/)),
    block_comment: (_) => token(choice(seq("(*", /[^*]*\*+([^)*][^*]*\*+)*/, ")"), seq("/*", /[^*]*\*+([^/*][^*]*\*+)*/, "/"))),
  },
});

function commaSep1(rule) {
  return seq(rule, repeat(seq(",", rule)));
}
