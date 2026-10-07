# Step through a test, ask why

**Debug Test** in the Testing view (or the gutter of a case) runs it in the debugger: breakpoints in your SCL blocks, stepping into the blocks they call, the block's variables and data blocks, values next to the code.

It steps backwards too: **Step Back** goes to the statement before. A case that fails stops where it shows, with the reason.

Right-click a variable → **Why?**: the statement that last wrote it, the values its operands had then (each explained in turn), and the IF branch that made it run.
