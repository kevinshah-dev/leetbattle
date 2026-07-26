export function generatePythonHarness(
  functionName: string,
  maxCapturedBytes: number,
): string {
  return `import contextlib
import io
import json
import importlib.util
import os
import sys
import time

MARKER = "__LEETBATTLE_PROTOCOL__"
FUNCTION_NAME = ${JSON.stringify(functionName)}
CAPTURE_LIMIT = ${maxCapturedBytes}
protocol_in = sys.__stdin__
protocol_out = sys.__stdout__

class OutputLimit(Exception):
    pass

class CappedWriter(io.TextIOBase):
    def __init__(self):
        self.used = 0

    def writable(self):
        return True

    def write(self, value):
        if not isinstance(value, str):
            value = str(value)
        size = len(value.encode("utf-8", errors="replace"))
        self.used += size
        if self.used > CAPTURE_LIMIT:
            raise OutputLimit()
        return len(value)

    def flush(self):
        return None

def emit(payload):
    protocol_out.write(MARKER + json.dumps(payload, separators=(",", ":"), allow_nan=False) + "\\n")
    protocol_out.flush()

capture = CappedWriter()
try:
    with contextlib.redirect_stdout(capture), contextlib.redirect_stderr(capture):
        spec = importlib.util.spec_from_file_location("solution", "/workspace/solution.py")
        if spec is None or spec.loader is None:
            raise RuntimeError()
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        Solution = module.Solution
except OutputLimit:
    emit({"kind": "case", "status": "output_limit", "runtimeMs": 0})
    raise SystemExit(0)
except MemoryError:
    emit({"kind": "case", "status": "memory_limit", "runtimeMs": 0})
    raise SystemExit(0)
except BaseException:
    emit({"kind": "case", "status": "runtime_error", "runtimeMs": 0})
    raise SystemExit(0)

emit({"kind": "ready", "compileMs": int(os.environ.get("LEETBATTLE_COMPILE_MS", "0"))})

for line in protocol_in:
    started = time.perf_counter_ns()
    capture = CappedWriter()
    try:
        packet = json.loads(line)
        arguments = packet["args"]
        with contextlib.redirect_stdout(capture), contextlib.redirect_stderr(capture):
            actual = getattr(Solution(), FUNCTION_NAME)(*arguments)
        encoded = json.dumps(actual, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
        if len(encoded.encode("utf-8")) > CAPTURE_LIMIT:
            raise OutputLimit()
        elapsed = (time.perf_counter_ns() - started) // 1_000_000
        emit({"kind": "case", "status": "ok", "actual": actual, "runtimeMs": elapsed})
    except OutputLimit:
        elapsed = (time.perf_counter_ns() - started) // 1_000_000
        emit({"kind": "case", "status": "output_limit", "runtimeMs": elapsed})
    except MemoryError:
        elapsed = (time.perf_counter_ns() - started) // 1_000_000
        emit({"kind": "case", "status": "memory_limit", "runtimeMs": elapsed})
    except BaseException:
        elapsed = (time.perf_counter_ns() - started) // 1_000_000
        emit({"kind": "case", "status": "runtime_error", "runtimeMs": elapsed})
`;
}
