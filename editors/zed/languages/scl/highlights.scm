; SPDX-License-Identifier: MIT

[
  "FUNCTION_BLOCK" "END_FUNCTION_BLOCK" "FUNCTION" "END_FUNCTION"
  "ORGANIZATION_BLOCK" "END_ORGANIZATION_BLOCK" "DATA_BLOCK" "END_DATA_BLOCK"
  "TYPE" "END_TYPE" "STRUCT" "END_STRUCT"
  "VAR_INPUT" "VAR_OUTPUT" "VAR_IN_OUT" "VAR_TEMP" "VAR_STAT" "VAR" "END_VAR"
  "CONSTANT" "RETAIN" "NON_RETAIN" "DB_SPECIFIC" "AT"
  "BEGIN" "TITLE" "VERSION" "AUTHOR" "FAMILY" "NAME"
  "KNOW_HOW_PROTECT" "READ_ONLY" "UNLINKED"
  "END_REGION"
  "PROGRAM" "END_PROGRAM" "METHOD" "END_METHOD" "PROPERTY" "END_PROPERTY" "GET" "END_GET" "SET" "END_SET" "INTERFACE" "END_INTERFACE"
  "EXTENDS" "IMPLEMENTS" "ABSTRACT" "FINAL" "PUBLIC" "PRIVATE" "PROTECTED" "INTERNAL"
  "VAR_GLOBAL" "VAR_INST" "VAR_EXTERNAL" "VAR_CONFIG" "PERSISTENT"
] @keyword

(region_header) @keyword

[
  "IF" "THEN" "ELSIF" "ELSE" "END_IF" "CASE" "OF" "END_CASE"
  "FOR" "TO" "BY" "DO" "END_FOR" "WHILE" "END_WHILE" "REPEAT" "UNTIL" "END_REPEAT"
] @keyword.control

[ "EXIT" "CONTINUE" "RETURN" "GOTO" ] @keyword.control.return

[ "AND" "OR" "XOR" "NOT" "MOD" ] @keyword.operator

[ ":=" "=>" "=" "<>" "<" ">" "<=" ">=" "+" "-" "*" "/" "**" "&" ] @operator
[ ";" ":" "," "." ".." ] @punctuation.delimiter
[ "(" ")" "[" "]" ] @punctuation.bracket

[ "ARRAY" "STRING" "WSTRING" "POINTER" "REFERENCE" "REF_TO" ] @type.builtin
[ (set_reset) (ref_bind) "?=" "^" ] @operator
(enum_value name: (identifier) @constant)
(program name: (_) @function)
(method name: (_) @function)
(property name: (_) @function)
(interface name: (_) @type)
(extends (identifier) @type)
(implements (identifier) @type)
(pointer_type (identifier) @type)
(var_declaration type: (identifier) @type)
(array_type (identifier) @type)
(function return_type: (identifier) @type)
(var_declaration type: (global_name) @type)

(function_block name: (_) @function)
(function name: (_) @function)
(organization_block name: (_) @function)
(data_block name: (_) @module)
(type_definition name: (_) @type)
(data_block of: (global_name) @type)

(var_declaration name: (_) @variable.parameter)
(local_variable) @variable
(global_name) @variable.special
(absolute_address) @constant.builtin

(call_expression function: (identifier) @function.call)
(call_expression function: (global_name) @function.call)
(argument name: (identifier) @variable.parameter)
(member_expression member: (identifier) @property)

(number) @number
(typed_literal) @number
(string) @string
(boolean) @constant.builtin
(pragma) @attribute
(title) @comment.doc
(line_comment) @comment
(block_comment) @comment
(label name: (identifier) @label)
