(* SPDX-License-Identifier: MIT *)
PROGRAM PRG_Strings
VAR CONSTANT
    cycles : UINT := 1;
END_VAR
VAR
    cycle : UINT;
    done : BOOL;
    text : STRING := 'ABCDE';
    empty : STRING;
    (* LEN counts characters in a nonempty STRING. *)
    r_len : INT;
    (* LEN of an empty STRING. *)
    r_len_empty : INT;
    (* LEFT takes the first two characters. *)
    r_left : STRING;
    (* LEFT with zero length. *)
    r_left_zero : STRING;
    (* RIGHT takes the last two characters. *)
    r_right : STRING;
    (* RIGHT with a length beyond the input. *)
    r_right_long : STRING;
    (* MID uses a one-based start position. *)
    r_mid : STRING;
    (* MID at the last character. *)
    r_mid_last : STRING;
    (* MID starting beyond the input. *)
    r_mid_past : STRING;
    (* CONCAT appends a second STRING. *)
    r_concat : STRING;
    (* FIND returns a one-based position. *)
    r_find : INT;
    (* FIND returns zero when absent. *)
    r_find_missing : INT;
    (* FIND of an empty search STRING. *)
    r_find_empty : INT;
    (* INSERT follows its specified character. *)
    r_insert : STRING;
    (* INSERT at the last character. *)
    r_insert_end : STRING;
    (* DELETE removes two characters from position two. *)
    r_delete : STRING;
    (* DELETE at the last character. *)
    r_delete_last : STRING;
    (* REPLACE exchanges two characters at position two. *)
    r_replace : STRING;
    (* REPLACE grows a string at its last character. *)
    r_replace_last : STRING;
    (* INSERT at zero prepends text in CODESYS. *)
    r_insert_zero : STRING;
    (* DELETE starting beyond the input. *)
    r_delete_past : STRING;
    (* REPLACE at position zero exposes edge behavior. *)
    r_replace_zero : STRING;
END_VAR
IF NOT done THEN
    cycle := cycle + 1;
    r_len := LEN(text);
    r_len_empty := LEN(empty);
    r_left := LEFT(text, 2);
    r_left_zero := LEFT(text, 0);
    r_right := RIGHT(text, 2);
    r_right_long := RIGHT(text, 8);
    r_mid := MID(text, 2, 2);
    r_mid_last := MID(text, 1, 5);
    r_mid_past := MID(text, 2, 6);
    r_concat := CONCAT(text, '!');
    r_find := FIND(text, 'CD');
    r_find_missing := FIND(text, 'XY');
    r_find_empty := FIND(text, empty);
    r_insert := INSERT(text, 'xy', 2);
    r_insert_end := INSERT(text, 'xy', 5);
    r_delete := DELETE(text, 2, 2);
    r_delete_last := DELETE(text, 1, 5);
    r_replace := REPLACE(text, 'xy', 2, 2);
    r_replace_last := REPLACE(text, 'xy', 1, 5);
    r_insert_zero := INSERT(text, 'xy', 0);
    r_delete_past := DELETE(text, 2, 6);
    r_replace_zero := REPLACE(text, 'xy', 1, 0);
    done := cycle >= cycles;
END_IF
END_PROGRAM
