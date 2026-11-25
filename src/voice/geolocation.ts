export type GeolocationResult =
  | { status: "granted"; latitude: number; longitude: number }
  | { status: "denied" }
  | { status: "unavailable" };

const GEOLOCATION_TIMEOUT_MS = 9000;
const GEOLOCATION_MAX_AGE_MS = 180000;

let sessionCachedCoords: { latitude: number; longitude: number } | null = null;
let sessionPermissionDenied = false;

function roundCoordinate(value: number): number {
  return Math.round(value * 100) / 100;
}

async function queryBrowserPermissionState(): Promise<
  "granted" | "denied" | "prompt" | "unknown"
> {
  if (
    typeof navigator === "undefined" ||
    !navigator.permissions ||
    typeof navigator.permissions.query !== "function"
  ) {
    return "unknown";
  }
  try {
    const status = await navigator.permissions.query({
      name: "geolocation" as PermissionName,
    });
    if (
      status.state === "granted" ||
      status.state === "denied" ||
      status.state === "prompt"
    ) {
      return status.state;
    }
  } catch {
    // Permissions API may reject in restricted iframes or older browsers
  }
  return "unknown";
}

export function clearSessionCoordinates(): void {
  sessionCachedCoords = null;
}

export function resetGeolocationSessionForTesting(): void {
  sessionCachedCoords = null;
  sessionPermissionDenied = false;
}

export async function requestBrowserLocation(): Promise<GeolocationResult> {
  if (sessionCachedCoords) {
    return {
      status: "granted",
      latitude: sessionCachedCoords.latitude,
      longitude: sessionCachedCoords.longitude,
    };
  }

  if (
    typeof window === "undefined" ||
    typeof navigator === "undefined" ||
    !navigator.geolocation
  ) {
    return { status: "unavailable" };
  }

  if (
    typeof window.isSecureContext === "boolean" &&
    !window.isSecureContext &&
    window.location.hostname !== "localhost" &&
    window.location.hostname !== "127.0.0.1"
  ) {
    return { status: "unavailable" };
  }

  const permissionState = await queryBrowserPermissionState();
  if (permissionState === "denied") {
    sessionPermissionDenied = true;
    return { status: "denied" };
  }
  if (permissionState === "granted") {
    sessionPermissionDenied = false;
  } else if (sessionPermissionDenied) {
    return { status: "denied" };
  }

  return new Promise((resolve) => {
    let settled = false;
    const guardTimer = window.setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve({ status: "unavailable" });
      }
    }, GEOLOCATION_TIMEOUT_MS + 1000);

    try {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(guardTimer);
          const lat = position.coords?.latitude;
          const lon = position.coords?.longitude;
          if (
            typeof lat === "number" &&
            Number.isFinite(lat) &&
            typeof lon === "number" &&
            Number.isFinite(lon)
          ) {
            const rounded = {
              latitude: roundCoordinate(lat),
              longitude: roundCoordinate(lon),
            };
            sessionCachedCoords = rounded;
            sessionPermissionDenied = false;
            resolve({ status: "granted", ...rounded });
          } else {
            resolve({ status: "unavailable" });
          }
        },
        (error) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(guardTimer);
          if (error?.code === 1) {
            sessionPermissionDenied = true;
            resolve({ status: "denied" });
          } else {
            resolve({ status: "unavailable" });
          }
        },
        {
          enableHighAccuracy: false,
          timeout: GEOLOCATION_TIMEOUT_MS,
          maximumAge: GEOLOCATION_MAX_AGE_MS,
        }
      );
    } catch {
      if (!settled) {
        settled = true;
        window.clearTimeout(guardTimer);
        resolve({ status: "unavailable" });
      }
    }
  });
}
