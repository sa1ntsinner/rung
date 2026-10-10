// SPDX-License-Identifier: BUSL-1.1
import {afterEach,expect,it,vi} from "vitest";
import {mkdtemp,readFile,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {main} from "../src/main.js";
import * as broker from "../src/liveServer.js";
const source=new URL("../../live/test/fixtures/trace/tia-v20-long-term.csv",import.meta.url);
afterEach(()=>vi.restoreAllMocks());
it("imports and inspects native CSV offline while preserving bytes/hash and refusing overwrite",async()=>{
 const root=await mkdtemp(join(tmpdir(),"rung-csv-")),csv=await readFile(source,"utf8");await writeFile(join(root,"native.csv"),csv);
 const io={cwd:root,env:{},stdout:vi.fn(),stderr:vi.fn()},open=vi.spyOn(broker,"brokerReader");
 expect(await main(["trace","import","native.csv","--out","trace.json","--json"],io)).toBe(0);
 const file=JSON.parse(await readFile(join(root,"trace.json"),"utf8"));expect(file.csv).toBe(csv);expect(file.source).toBe("tia-long-term-csv");
 expect(await main(["trace","import","native.csv","--out","trace.json"],io)).toBe(1);expect(await readFile(join(root,"trace.json"),"utf8")).toContain(file.sourceSha256);
 io.stdout.mockClear();expect(await main(["trace","inspect","trace.json","--json"],io)).toBe(0);const view=JSON.parse(io.stdout.mock.calls[0]![0]);expect(view.frames[1].sourceTimestamp).toBe("2023-11-14-22:13:20.100000123");expect(view.frames[1].elapsedMs).toBe(100.000123);
 await writeFile(join(root,"tampered.json"),JSON.stringify({...file,csv:csv.replace("0.25","7.25")}));expect(await main(["trace","inspect","tampered.json"],io)).toBe(1);expect(io.stderr).toHaveBeenCalledWith(expect.stringContaining("SHA256"));expect(open).not.toHaveBeenCalled();
});
