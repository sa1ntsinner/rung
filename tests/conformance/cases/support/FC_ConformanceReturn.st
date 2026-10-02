(* SPDX-License-Identifier: MIT *)
FUNCTION FC_ConformanceReturn : INT
VAR_INPUT
    value : INT;
END_VAR
FC_ConformanceReturn := value;
IF value < 0 THEN
    RETURN;
END_IF
FC_ConformanceReturn := value + 10;
END_FUNCTION
