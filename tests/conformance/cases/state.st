(* SPDX-License-Identifier: MIT *)
PROGRAM PRG_State
VAR CONSTANT
    cycles : UINT := 8;
END_VAR
VAR
    cycle : UINT;
    done : BOOL;
    first : FB_ConformanceAccumulate;
    second : FB_ConformanceAccumulate;
    rising : R_TRIG;
    falling : F_TRIG;
    up : CTU;
    down : CTD;
    both : CTUD;
    set_latch : SR;
    reset_latch : RS;
    pulse : BOOL;
    (* An FB instance keeps its accumulator across cycles. *)
    r_fb_first : INT;
    (* Two instances of one FB keep independent state. *)
    r_fb_second : INT;
    (* R_TRIG fires once per rising edge. *)
    r_rising_count : INT;
    (* F_TRIG fires once per falling edge. *)
    r_falling_count : INT;
    (* F_TRIG on an initially false signal. *)
    r_falling_initial : BOOL;
    (* CTU reaches its preset after two edges. *)
    r_up_at_preset : WORD;
    (* CTU behavior on edges beyond its preset. *)
    r_up_after_preset : WORD;
    (* CTU Q at and beyond its preset. *)
    r_up_q : BOOL;
    (* CTD reaches zero from its loaded preset. *)
    r_down_zero : WORD;
    (* CTD behavior on an edge after reaching zero. *)
    r_down_after_zero : WORD;
    (* CTD Q after reaching zero. *)
    r_down_q : BOOL;
    (* CTUD handles simultaneous rising up and down edges. *)
    r_both_simultaneous : WORD;
    (* CTUD RESET and LOAD are asserted together. *)
    r_both_reset_load : WORD;
    (* CTUD upper output after reset. *)
    r_both_qu : BOOL;
    (* CTUD lower output after reset. *)
    r_both_qd : BOOL;
    (* SR is set dominant when both inputs are true. *)
    r_sr_both : BOOL;
    (* RS is reset dominant when both inputs are true. *)
    r_rs_both : BOOL;
    (* SR keeps its value after both inputs fall. *)
    r_sr_hold : BOOL;
    (* RS keeps its value after both inputs fall. *)
    r_rs_hold : BOOL;
END_VAR
IF NOT done THEN
    cycle := cycle + 1;
    pulse := (cycle MOD 2) = 0;
    first(increment := 1);
    second(increment := 3);
    r_fb_first := first.total;
    r_fb_second := second.total;
    rising(CLK := pulse);
    falling(CLK := pulse);
    IF rising.Q THEN r_rising_count := r_rising_count + 1; END_IF
    IF falling.Q THEN r_falling_count := r_falling_count + 1; END_IF
    IF cycle = 1 THEN r_falling_initial := falling.Q; END_IF
    up(CU := pulse, RESET := cycle = 1, PV := WORD#2);
    down(CD := pulse, LOAD := cycle = 1, PV := WORD#2);
    both(CU := pulse, CD := cycle = 4, RESET := cycle = 1 OR cycle = 8, LOAD := cycle = 8, PV := WORD#3);
    set_latch(SET1 := cycle = 2, RESET := cycle = 2);
    reset_latch(SET := cycle = 2, RESET1 := cycle = 2);
    IF cycle = 2 THEN
        r_sr_both := set_latch.Q1;
        r_rs_both := reset_latch.Q1;
    END_IF
    IF cycle = 3 THEN
        r_sr_hold := set_latch.Q1;
        r_rs_hold := reset_latch.Q1;
    END_IF
    IF cycle = 4 THEN
        r_up_at_preset := up.CV;
        r_down_zero := down.CV;
        r_both_simultaneous := both.CV;
    END_IF
    IF cycle = 6 THEN
        r_up_after_preset := up.CV;
        r_up_q := up.Q;
        r_down_after_zero := down.CV;
        r_down_q := down.Q;
    END_IF
    IF cycle = 8 THEN
        r_both_reset_load := both.CV;
        r_both_qu := both.QU;
        r_both_qd := both.QD;
    END_IF
    done := cycle >= cycles;
END_IF
END_PROGRAM
