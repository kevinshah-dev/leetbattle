import { ArcadeLink, PixelPanel } from "./ArcadePrimitives";

export function RoomLoading({
  label = "Restoring authoritative room state…",
}: {
  label?: string;
}) {
  return (
    <main className="room-state" id="main-content">
      <span className="pixel-loader" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
        <i />
      </span>
      <p aria-live="polite">{label}</p>
    </main>
  );
}

export function RoomError({ message }: { message: string }) {
  return (
    <main className="room-state" id="main-content">
      <PixelPanel label="ROOM LINK FAILED">
        <h1>Signal lost.</h1>
        <p>{message}</p>
        <ArcadeLink href="/" tone="ghost">
          Return home
        </ArcadeLink>
      </PixelPanel>
    </main>
  );
}
