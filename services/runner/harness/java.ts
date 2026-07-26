import type { PublicProblem, ValueType } from "../../../src/problems/types";

function conversion(type: ValueType, index: number): string {
  const value = `arguments.get(${index})`;
  switch (type) {
    case "int":
      return `asInt(${value})`;
    case "long":
      return `asLong(${value})`;
    case "string":
      return `asString(${value})`;
    case "int[]":
      return `asIntArray(${value})`;
    case "string[]":
      return `asStringArray(${value})`;
    case "int[][]":
      return `asIntMatrix(${value})`;
    case "string[][]":
      return `asStringMatrix(${value})`;
  }
}

export function generateJavaHarness(
  problem: PublicProblem,
  maxCapturedBytes: number,
): string {
  const callArguments = problem.argumentTypes.map(conversion).join(", ");
  return `import java.io.*;
import java.lang.reflect.Array;
import java.nio.charset.StandardCharsets;
import java.util.*;

class Harness {
    private static final String MARKER = "__LEETBATTLE_PROTOCOL__";
    private static final int CAPTURE_LIMIT = ${maxCapturedBytes};
    private static final PrintStream PROTOCOL_OUT = System.out;

    private static final class OutputLimit extends RuntimeException {}

    private static final class CappedOutputStream extends OutputStream {
        private int used;
        @Override public void write(int value) {
            if (++used > CAPTURE_LIMIT) throw new OutputLimit();
        }
        @Override public void write(byte[] bytes, int offset, int length) {
            used += length;
            if (used > CAPTURE_LIMIT) throw new OutputLimit();
        }
    }

    private static void emit(String json) {
        PROTOCOL_OUT.println(MARKER + json);
        PROTOCOL_OUT.flush();
    }

    private static int asInt(Object value) { return ((Number) value).intValue(); }
    private static long asLong(Object value) { return ((Number) value).longValue(); }
    private static String asString(Object value) { return (String) value; }
    private static int[] asIntArray(Object value) {
        List<?> list = (List<?>) value;
        int[] result = new int[list.size()];
        for (int i = 0; i < result.length; i++) result[i] = asInt(list.get(i));
        return result;
    }
    private static String[] asStringArray(Object value) {
        List<?> list = (List<?>) value;
        String[] result = new String[list.size()];
        for (int i = 0; i < result.length; i++) result[i] = asString(list.get(i));
        return result;
    }
    private static int[][] asIntMatrix(Object value) {
        List<?> list = (List<?>) value;
        int[][] result = new int[list.size()][];
        for (int i = 0; i < result.length; i++) result[i] = asIntArray(list.get(i));
        return result;
    }
    private static String[][] asStringMatrix(Object value) {
        List<?> list = (List<?>) value;
        String[][] result = new String[list.size()][];
        for (int i = 0; i < result.length; i++) result[i] = asStringArray(list.get(i));
        return result;
    }

    private static String json(Object value) {
        StringBuilder output = new StringBuilder();
        appendJson(output, value, 0);
        if (output.toString().getBytes(StandardCharsets.UTF_8).length > CAPTURE_LIMIT) throw new OutputLimit();
        return output.toString();
    }

    private static void appendJson(StringBuilder output, Object value, int depth) {
        if (depth > 100) throw new IllegalArgumentException();
        if (value == null) { output.append("null"); return; }
        if (value instanceof String string) {
            output.append('"');
            for (int i = 0; i < string.length(); i++) {
                char character = string.charAt(i);
                switch (character) {
                    case '"' -> output.append((char) 92).append('"');
                    case '\\\\' -> output.append("\\\\\\\\");
                    case '\\b' -> output.append("\\\\b");
                    case '\\f' -> output.append("\\\\f");
                    case '\\n' -> output.append("\\\\n");
                    case '\\r' -> output.append("\\\\r");
                    case '\\t' -> output.append("\\\\t");
                    default -> {
                        if (character < 0x20) output.append(String.format("\\\\u%04x", (int) character));
                        else output.append(character);
                    }
                }
            }
            output.append('"');
            return;
        }
        if (value instanceof Number || value instanceof Boolean) { output.append(value); return; }
        Iterable<?> iterable;
        if (value instanceof Iterable<?> found) iterable = found;
        else if (value.getClass().isArray()) {
            List<Object> array = new ArrayList<>();
            for (int i = 0; i < Array.getLength(value); i++) array.add(Array.get(value, i));
            iterable = array;
        } else throw new IllegalArgumentException();
        output.append('[');
        boolean first = true;
        for (Object entry : iterable) {
            if (!first) output.append(',');
            first = false;
            appendJson(output, entry, depth + 1);
        }
        output.append(']');
    }

    public static void main(String[] ignored) throws Exception {
        emit("{\\\"kind\\\":\\\"ready\\\",\\\"compileMs\\\":" + System.getenv().getOrDefault("LEETBATTLE_COMPILE_MS", "0") + "}");
        BufferedReader input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        for (String line; (line = input.readLine()) != null;) {
            long started = System.nanoTime();
            try {
                Object decoded = new JsonParser(line).parse();
                List<?> arguments = (List<?>) ((Map<?, ?>) decoded).get("args");
                CappedOutputStream captured = new CappedOutputStream();
                System.setOut(new PrintStream(captured, true, StandardCharsets.UTF_8));
                System.setErr(new PrintStream(captured, true, StandardCharsets.UTF_8));
                Object actual = new Solution().${problem.functionName}(${callArguments});
                System.setOut(PROTOCOL_OUT);
                System.setErr(PROTOCOL_OUT);
                long elapsed = (System.nanoTime() - started) / 1_000_000L;
                emit("{\\\"kind\\\":\\\"case\\\",\\\"status\\\":\\\"ok\\\",\\\"actual\\\":" + json(actual) + ",\\\"runtimeMs\\\":" + elapsed + "}");
            } catch (OutputLimit error) {
                System.setOut(PROTOCOL_OUT); System.setErr(PROTOCOL_OUT);
                emit("{\\\"kind\\\":\\\"case\\\",\\\"status\\\":\\\"output_limit\\\",\\\"runtimeMs\\\":" + ((System.nanoTime() - started) / 1_000_000L) + "}");
            } catch (OutOfMemoryError error) {
                System.setOut(PROTOCOL_OUT); System.setErr(PROTOCOL_OUT);
                emit("{\\\"kind\\\":\\\"case\\\",\\\"status\\\":\\\"memory_limit\\\",\\\"runtimeMs\\\":" + ((System.nanoTime() - started) / 1_000_000L) + "}");
            } catch (Throwable error) {
                System.setOut(PROTOCOL_OUT); System.setErr(PROTOCOL_OUT);
                emit("{\\\"kind\\\":\\\"case\\\",\\\"status\\\":\\\"runtime_error\\\",\\\"runtimeMs\\\":" + ((System.nanoTime() - started) / 1_000_000L) + "}");
            }
        }
    }

    private static final class JsonParser {
        private final String source;
        private int index;
        JsonParser(String source) { this.source = source; }
        Object parse() { Object value = value(); whitespace(); if (index != source.length()) throw new IllegalArgumentException(); return value; }
        private Object value() {
            whitespace();
            if (index >= source.length()) throw new IllegalArgumentException();
            return switch (source.charAt(index)) {
                case '{' -> object();
                case '[' -> array();
                case '"' -> string();
                case 'n' -> { literal("null"); yield null; }
                case 't' -> { literal("true"); yield true; }
                case 'f' -> { literal("false"); yield false; }
                default -> number();
            };
        }
        private Map<String, Object> object() {
            index++; Map<String, Object> result = new HashMap<>(); whitespace();
            if (take('}')) return result;
            do { String key = string(); whitespace(); require(':'); result.put(key, value()); whitespace(); } while (take(','));
            require('}'); return result;
        }
        private List<Object> array() {
            index++; List<Object> result = new ArrayList<>(); whitespace();
            if (take(']')) return result;
            do { result.add(value()); whitespace(); } while (take(','));
            require(']'); return result;
        }
        private String string() {
            require('"'); StringBuilder result = new StringBuilder();
            while (index < source.length()) {
                char character = source.charAt(index++);
                if (character == '"') return result.toString();
                if (character != '\\\\') { result.append(character); continue; }
                char escape = source.charAt(index++);
                switch (escape) {
                    case '"', '\\\\', '/' -> result.append(escape);
                    case 'b' -> result.append('\\b'); case 'f' -> result.append('\\f');
                    case 'n' -> result.append('\\n'); case 'r' -> result.append('\\r'); case 't' -> result.append('\\t');
                    case 'u' -> { result.append((char) Integer.parseInt(source.substring(index, index + 4), 16)); index += 4; }
                    default -> throw new IllegalArgumentException();
                }
            }
            throw new IllegalArgumentException();
        }
        private Long number() {
            int start = index; if (source.charAt(index) == '-') index++;
            while (index < source.length() && Character.isDigit(source.charAt(index))) index++;
            return Long.parseLong(source.substring(start, index));
        }
        private void literal(String expected) { if (!source.startsWith(expected, index)) throw new IllegalArgumentException(); index += expected.length(); }
        private void whitespace() { while (index < source.length() && Character.isWhitespace(source.charAt(index))) index++; }
        private boolean take(char expected) { if (index < source.length() && source.charAt(index) == expected) { index++; return true; } return false; }
        private void require(char expected) { if (!take(expected)) throw new IllegalArgumentException(); }
    }
}
`;
}
