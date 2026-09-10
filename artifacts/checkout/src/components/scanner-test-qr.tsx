import { cn } from "@/lib/utils";

const QUIET_ZONE = 4;

function matrixPath(matrix: readonly string[]): string {
  const commands: string[] = [];
  matrix.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      while (x < row.length && row[x] !== "1") x += 1;
      const start = x;
      while (x < row.length && row[x] === "1") x += 1;
      if (x > start) {
        commands.push(
          `M${start + QUIET_ZONE} ${y + QUIET_ZONE}h${x - start}v1H${start + QUIET_ZONE}z`,
        );
      }
    }
  });
  return commands.join("");
}

export function ScannerTestQr({
  matrix,
  label,
  className,
}: {
  matrix: readonly string[];
  label: string;
  className?: string;
}) {
  const size = matrix.length + QUIET_ZONE * 2;
  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
      className={cn("block bg-white", className)}
    >
      <title>{label}</title>
      <rect width={size} height={size} fill="#ffffff" />
      <path d={matrixPath(matrix)} fill="#000000" />
    </svg>
  );
}
