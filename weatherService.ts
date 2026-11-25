import { Type, type FunctionDeclaration } from "@google/genai";

export type WeatherScope =
  | "current"
  | "hourly"
  | "daily"
  | "precipitation"
  | "full";

export type WeatherErrorCode =
  | "WEATHER_GEOCODING_FAILED"
  | "WEATHER_RATE_LIMITED"
  | "WEATHER_TIMEOUT"
  | "WEATHER_NETWORK_ERROR"
  | "WEATHER_INVALID_RESPONSE"
  | "WEATHER_API_ERROR";

export type WeatherClarificationKind =
  | "invalid_city"
  | "ambiguous_city"
  | "missing_location";

export interface WeatherAttribution {
  provider: "Open-Meteo";
  url: "https://open-meteo.com/";
  notice: string;
  geocodingNotice: string;
}

export interface WeatherCurrentConditions {
  observedAtLocal: string;
  condition: string;
  weatherCode: number | null;
  temperatureC: number | null;
  feelsLikeC: number | null;
  humidityPercent: number | null;
  windSpeedKmh: number | null;
  windDirectionDegrees: number | null;
  windDirectionCardinal: string | null;
  precipitationMm: number | null;
}

export interface WeatherHourlyPoint {
  timeLocal: string;
  hourLabel: string;
  condition: string;
  weatherCode: number | null;
  temperatureC: number | null;
  feelsLikeC: number | null;
  humidityPercent: number | null;
  precipitationProbabilityPercent: number | null;
  precipitationMm: number | null;
  windSpeedKmh: number | null;
  windDirectionCardinal: string | null;
}

export interface WeatherDailyPoint {
  date: string;
  dayOfWeek: string;
  condition: string;
  weatherCode: number | null;
  tempMaxC: number | null;
  tempMinC: number | null;
  precipitationProbabilityMaxPercent: number | null;
  precipitationSumMm: number | null;
  windSpeedMaxKmh: number | null;
  windDirectionCardinal: string | null;
}

export interface WeatherPrecipitationSummary {
  currentPrecipitationMm: number | null;
  next6HoursMaxProbabilityPercent: number | null;
  next24HoursMaxProbabilityPercent: number | null;
  todayTotalPrecipitationMm: number | null;
  todayMaxProbabilityPercent: number | null;
}

export interface ResolvedWeatherLocation {
  name: string;
  resolvedFrom: "geocoding" | "device_geolocation";
  timezone: string;
  timezoneAbbreviation: string | null;
  utcOffsetSeconds: number;
}

export interface WeatherLocationCandidate {
  name: string;
  label: string;
  region: string | null;
  country: string | null;
  timezone: string | null;
  population: number | null;
}

export interface WeatherSuccessResult {
  status: "ok";
  dataKind: "real_time_and_forecast";
  distinctionNote: string;
  scope: WeatherScope;
  fetchedAt: string;
  cached: boolean;
  cacheAgeSeconds: number;
  location: ResolvedWeatherLocation;
  units: {
    temperature: "°C";
    windSpeed: "km/h";
    precipitation: "mm";
    humidity: "%";
    precipitationProbability: "%";
  };
  current?: WeatherCurrentConditions;
  precipitationSummary?: WeatherPrecipitationSummary;
  hourlyForecast?: WeatherHourlyPoint[];
  dailyForecast?: WeatherDailyPoint[];
  attribution: WeatherAttribution;
}

export interface WeatherNotFoundResult {
  status: "not_found";
  query: string;
  scope: WeatherScope;
  needsClarification: true;
  clarificationKind: "invalid_city";
  message: string;
  recommendedSpokenResponse: string;
  attribution: WeatherAttribution;
}

export interface WeatherAmbiguousResult {
  status: "ambiguous";
  query: string;
  scope: WeatherScope;
  needsClarification: true;
  clarificationKind: "ambiguous_city";
  candidates: WeatherLocationCandidate[];
  message: string;
  recommendedSpokenResponse: string;
  attribution: WeatherAttribution;
}

export interface WeatherPermissionResult {
  status:
    | "missing_location"
    | "location_permission_denied"
    | "location_unavailable";
  scope: WeatherScope;
  needsClarification: true;
  clarificationKind: "missing_location";
  message: string;
  recommendedSpokenResponse: string;
  attribution: WeatherAttribution;
}

export interface WeatherErrorResult {
  status: "error";
  errorCode: WeatherErrorCode;
  query: string;
  scope: WeatherScope;
  message: string;
  recommendedSpokenResponse: string;
  retryAfterSeconds?: number;
  attribution: WeatherAttribution;
}

export type WeatherToolResult =
  | WeatherSuccessResult
  | WeatherNotFoundResult
  | WeatherAmbiguousResult
  | WeatherPermissionResult
  | WeatherErrorResult;

export interface WeatherExecutionMetrics {
  geocodingMs: number;
  weatherRetrievalMs: number;
  responsePreparationMs: number;
  totalMs: number;
  cacheHit: boolean;
  geocodeCacheHit: boolean;
  scope: WeatherScope;
}

export type LocalLocationResolution =
  | { status: "granted"; latitude: number; longitude: number }
  | { status: "denied" }
  | { status: "unavailable" };

export interface WeatherToolDependencies {
  resolveLocalLocation?: () => Promise<LocalLocationResolution>;
  fallbackTimeZone?: string;
}

export const OPEN_METEO_ATTRIBUTION: WeatherAttribution = {
  provider: "Open-Meteo",
  url: "https://open-meteo.com/",
  notice: "Weather data by Open-Meteo.com",
  geocodingNotice: "Location lookup via Open-Meteo Geocoding / GeoNames",
};

export const INVALID_CITY_SPOKEN_PROMPT =
  "I couldn't find that city. Could you please tell me the correct city name?";

export const WEATHER_FUNCTION_DECLARATION: FunctionDeclaration = {
  name: "get_weather",
  description:
    "Fetches real-time current weather conditions, feels-like temperature, humidity, wind speed/direction, precipitation probability, upcoming hourly forecast, and 7-day forecast in Celsius, km/h, and mm using the Open-Meteo API. Use scope to request only what the question needs.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      location: {
        type: Type.STRING,
        description:
          "City or place name when the user asks about a specific city or region (e.g., 'Tokyo', 'London', 'Portland, Oregon', 'Guwahati'). Leave empty or omit when asking about the user's current local weather.",
      },
      useUserLocalLocation: {
        type: Type.BOOLEAN,
        description:
          "Set to true ONLY when the user asks about weather at their current location without naming a city (e.g., 'What is the weather like right now?', 'Will it rain today?'). Set to false when a city is named.",
      },
      scope: {
        type: Type.STRING,
        enum: ["current", "hourly", "daily", "precipitation", "full"],
        description:
          "Primary focus of the user's weather question: 'current' for right now, 'hourly' for hour-by-hour today/tonight, 'daily' for 7-day/weekly outlook, 'precipitation' for rain/snow chance, or 'full' only for multi-part requests.",
      },
    },
  },
};

const OPEN_METEO_FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const OPEN_METEO_GEOCODING_URL =
  "https://geocoding-api.open-meteo.com/v1/search";

const REQUEST_TIMEOUT_MS = 5000;
export const CURRENT_WEATHER_CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes
export const FORECAST_WEATHER_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
export const GEOCODE_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 30 * 1000;
const MAX_RATE_LIMIT_COOLDOWN_MS = 120 * 1000;
const MAX_CACHE_ENTRIES = 200;
const HOURLY_SLICE_LIMIT = 18;
const PRECIP_HOURLY_SLICE_LIMIT = 12;
const DAILY_SLICE_LIMIT = 7;

const WMO_WEATHER_DESCRIPTIONS: Record<number, string> = {
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Depositing rime fog",
  51: "Light drizzle",
  53: "Moderate drizzle",
  55: "Dense drizzle",
  56: "Light freezing drizzle",
  57: "Dense freezing drizzle",
  61: "Slight rain",
  63: "Moderate rain",
  65: "Heavy rain",
  66: "Light freezing rain",
  67: "Heavy freezing rain",
  71: "Slight snow fall",
  73: "Moderate snow fall",
  75: "Heavy snow fall",
  77: "Snow grains",
  80: "Slight rain showers",
  81: "Moderate rain showers",
  82: "Violent rain showers",
  85: "Slight snow showers",
  86: "Heavy snow showers",
  95: "Thunderstorm",
  96: "Thunderstorm with slight hail",
  99: "Thunderstorm with heavy hail",
};

export function roundCoordinate(value: number): number {
  return Math.round(value * 100) / 100;
}

export function describeWmoWeatherCode(code: number | null): string {
  if (code === null || !Number.isFinite(code)) {
    return "Unknown conditions";
  }
  const rounded = Math.round(code);
  return WMO_WEATHER_DESCRIPTIONS[rounded] ?? `Weather code ${rounded}`;
}

export function degreesToCardinalDirection(
  degrees: number | null
): string | null {
  if (degrees === null || !Number.isFinite(degrees)) {
    return null;
  }
  const directions = [
    "N",
    "NNE",
    "NE",
    "ENE",
    "E",
    "ESE",
    "SE",
    "SSE",
    "S",
    "SSW",
    "SW",
    "WSW",
    "W",
    "WNW",
    "NW",
    "NNW",
  ];
  const normalized = ((degrees % 360) + 360) % 360;
  const idx = Math.round(normalized / 22.5) % 16;
  return directions[idx] ?? null;
}

function finiteOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return null;
}

function roundOneDecimalOrNull(value: unknown): number | null {
  const num = finiteOrNull(value);
  return num === null ? null : Math.round(num * 10) / 10;
}

function roundIntOrNull(value: unknown): number | null {
  const num = finiteOrNull(value);
  return num === null ? null : Math.round(num);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function formatHourLabel(isoLocal: string): string {
  const match = /T(\d{2}):(\d{2})/.exec(isoLocal);
  if (!match) return isoLocal;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return isoLocal;
  const period = hour >= 12 ? "PM" : "AM";
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return minute === 0
    ? `${hour12} ${period}`
    : `${hour12}:${String(minute).padStart(2, "0")} ${period}`;
}

function formatDayOfWeek(isoDate: string): string {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!parts) return isoDate;
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const utcDate = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  if (Number.isNaN(utcDate.getTime())) return isoDate;
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    timeZone: "UTC",
  }).format(utcDate);
}

function parseRetryAfterSeconds(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined;
  const trimmed = headerValue.trim();
  if (!trimmed) return undefined;
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.ceil(numeric);
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) {
    const diffSec = Math.ceil((dateMs - Date.now()) / 1000);
    return diffSec > 0 ? diffSec : undefined;
  }
  return undefined;
}

export function normalizeWeatherScope(rawScope: unknown): WeatherScope {
  switch (rawScope) {
    case "current":
    case "hourly":
    case "daily":
    case "precipitation":
    case "full":
      return rawScope;
    default:
      return "full";
  }
}

interface GeocodedPlace {
  name: string;
  latitude: number;
  longitude: number;
  timezone?: string;
}

type GeocodeResolution =
  | { kind: "resolved"; place: GeocodedPlace }
  | { kind: "not_found" }
  | { kind: "ambiguous"; candidates: WeatherLocationCandidate[] };

interface OpenMeteoGeocodeApiItem {
  name?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  country?: unknown;
  country_code?: unknown;
  admin1?: unknown;
  timezone?: unknown;
  population?: unknown;
  feature_code?: unknown;
}

interface OpenMeteoForecastPayload {
  latitude?: unknown;
  longitude?: unknown;
  utc_offset_seconds?: unknown;
  timezone?: unknown;
  timezone_abbreviation?: unknown;
  current?: Record<string, unknown>;
  hourly?: Record<string, unknown>;
  daily?: Record<string, unknown>;
}

interface CacheEntry<T> {
  value: T;
  cachedAtMs: number;
  expiresAt: number;
}

interface ScopedForecastData {
  fetchedAt: string;
  timezone: string;
  timezoneAbbreviation: string | null;
  utcOffsetSeconds: number;
  current?: WeatherCurrentConditions;
  precipitationSummary?: WeatherPrecipitationSummary;
  hourlyForecast?: WeatherHourlyPoint[];
  dailyForecast?: WeatherDailyPoint[];
}

export type FetchLike = typeof fetch;

class WeatherServiceHttpError extends Error {
  readonly code: WeatherErrorCode;
  readonly retryAfterSeconds?: number;

  constructor(
    code: WeatherErrorCode,
    message: string,
    retryAfterSeconds?: number
  ) {
    super(message);
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function formatPlaceDisplayName(item: OpenMeteoGeocodeApiItem): string {
  const name = stringOrNull(item.name) ?? "Unknown location";
  const admin1 = stringOrNull(item.admin1);
  const country = stringOrNull(item.country);
  const parts = [name];
  if (admin1 && admin1.toLowerCase() !== name.toLowerCase()) {
    parts.push(admin1);
  }
  if (country && country.toLowerCase() !== name.toLowerCase()) {
    parts.push(country);
  }
  return parts.join(", ");
}

function isPopulatedPlaceFeatureCode(featureCode: string | null): boolean {
  if (!featureCode) return true;
  return featureCode.startsWith("PPL") || featureCode.startsWith("ADM");
}

function resolveGeocodeCandidates(
  items: OpenMeteoGeocodeApiItem[],
  cityQuery: string,
  qualifierHint?: string
): GeocodeResolution {
  const valid = items.filter(
    (item) =>
      typeof item.latitude === "number" &&
      Number.isFinite(item.latitude) &&
      typeof item.longitude === "number" &&
      Number.isFinite(item.longitude) &&
      typeof item.name === "string"
  );
  if (valid.length === 0) {
    return { kind: "not_found" };
  }

  // Prefer actual populated places over airports/stations when both exist
  const populatedOnly = valid.filter((item) =>
    isPopulatedPlaceFeatureCode(stringOrNull(item.feature_code))
  );
  const pool = populatedOnly.length > 0 ? populatedOnly : valid;

  // Deduplicate by formatted display label
  const seenLabels = new Set<string>();
  const deduped: OpenMeteoGeocodeApiItem[] = [];
  for (const item of pool) {
    const label = formatPlaceDisplayName(item).toLowerCase();
    if (!seenLabels.has(label)) {
      seenLabels.add(label);
      deduped.push(item);
    }
  }

  if (qualifierHint) {
    const tokens = qualifierHint
      .toLowerCase()
      .split(/[\s,]+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 2);
    if (tokens.length > 0) {
      const scored = deduped
        .map((item) => {
          const hay = [
            stringOrNull(item.admin1) ?? "",
            stringOrNull(item.country) ?? "",
            stringOrNull(item.country_code) ?? "",
          ]
            .join(" ")
            .toLowerCase();
          const score = tokens.reduce(
            (acc, token) => (hay.includes(token) ? acc + 1 : acc),
            0
          );
          return { item, score };
        })
        .sort((a, b) => b.score - a.score);
      if (scored[0] && scored[0].score > 0) {
        const chosen = scored[0].item;
        return {
          kind: "resolved",
          place: {
            name: formatPlaceDisplayName(chosen),
            latitude: roundCoordinate(chosen.latitude as number),
            longitude: roundCoordinate(chosen.longitude as number),
            timezone: stringOrNull(chosen.timezone) ?? undefined,
          },
        };
      }
    }
  }

  const normalizedCity = cityQuery.trim().toLowerCase();
  const exactNameMatches = deduped.filter(
    (item) => (stringOrNull(item.name) ?? "").toLowerCase() === normalizedCity
  );
  const ambiguityPool = exactNameMatches.length >= 2 ? exactNameMatches : deduped;

  if (!qualifierHint && ambiguityPool.length >= 2) {
    const sortedByPop = [...ambiguityPool].sort(
      (a, b) => (finiteOrNull(b.population) ?? 0) - (finiteOrNull(a.population) ?? 0)
    );
    const first = sortedByPop[0];
    const second = sortedByPop[1];
    const pop1 = finiteOrNull(first.population);
    const pop2 = finiteOrNull(second.population);

    const isCloseMajorTie =
      pop1 !== null &&
      pop2 !== null &&
      pop2 > 0 &&
      (pop1 / pop2 < 2.2 || (pop2 >= 50000 && pop1 / pop2 < 2.5));
    const bothMissingPopulationExactTie =
      exactNameMatches.length >= 2 && pop1 === null && pop2 === null;

    if (isCloseMajorTie || bothMissingPopulationExactTie) {
      const candidates: WeatherLocationCandidate[] = sortedByPop
        .slice(0, 3)
        .map((item) => ({
          name: stringOrNull(item.name) ?? cityQuery,
          label: formatPlaceDisplayName(item),
          region: stringOrNull(item.admin1),
          country: stringOrNull(item.country),
          timezone: stringOrNull(item.timezone),
          population: finiteOrNull(item.population),
        }));
      return { kind: "ambiguous", candidates };
    }
  }

  const chosen = deduped[0];
  return {
    kind: "resolved",
    place: {
      name: formatPlaceDisplayName(chosen),
      latitude: roundCoordinate(chosen.latitude as number),
      longitude: roundCoordinate(chosen.longitude as number),
      timezone: stringOrNull(chosen.timezone) ?? undefined,
    },
  };
}

function arrayAt(arr: unknown, idx: number): unknown {
  return Array.isArray(arr) && idx >= 0 && idx < arr.length ? arr[idx] : null;
}

function splitLocationQuery(rawQuery: string): {
  searchName: string;
  qualifierHint?: string;
} {
  const cleaned = rawQuery.trim().replace(/\s+/g, " ");
  const commaIdx = cleaned.indexOf(",");
  if (commaIdx > 0) {
    const cityPart = cleaned.slice(0, commaIdx).trim();
    const qualifierPart = cleaned.slice(commaIdx + 1).trim();
    if (cityPart.length >= 2) {
      return {
        searchName: cityPart,
        qualifierHint: qualifierPart.length >= 2 ? qualifierPart : undefined,
      };
    }
  }
  return { searchName: cleaned };
}

function getCacheTtlForScope(scope: WeatherScope): number {
  return scope === "current" || scope === "full"
    ? CURRENT_WEATHER_CACHE_TTL_MS
    : FORECAST_WEATHER_CACHE_TTL_MS;
}

function buildOpenMeteoForecastParams(
  latStr: string,
  lonStr: string,
  scope: WeatherScope
): URLSearchParams {
  const params = new URLSearchParams({
    latitude: latStr,
    longitude: lonStr,
    temperature_unit: "celsius",
    wind_speed_unit: "kmh",
    precipitation_unit: "mm",
    timezone: "auto",
  });

  switch (scope) {
    case "current":
      params.set(
        "current",
        "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_direction_10m"
      );
      break;
    case "hourly":
      params.set("current", "temperature_2m,weather_code");
      params.set(
        "hourly",
        "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m,wind_direction_10m"
      );
      params.set("forecast_days", "2");
      break;
    case "daily":
      params.set("current", "temperature_2m,weather_code");
      params.set(
        "daily",
        "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,wind_direction_10m_dominant"
      );
      params.set("forecast_days", "7");
      break;
    case "precipitation":
      params.set("current", "precipitation,weather_code,temperature_2m");
      params.set(
        "hourly",
        "precipitation_probability,precipitation,weather_code"
      );
      params.set(
        "daily",
        "precipitation_sum,precipitation_probability_max,weather_code"
      );
      params.set("forecast_days", "2");
      break;
    case "full":
      params.set(
        "current",
        "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_direction_10m"
      );
      params.set(
        "hourly",
        "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m,wind_direction_10m"
      );
      params.set(
        "daily",
        "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,wind_direction_10m_dominant"
      );
      params.set("forecast_days", "7");
      break;
  }

  return params;
}

export class WeatherCoordinator {
  private readonly fetchImpl: FetchLike;
  private readonly nowFn: () => number;
  private readonly timeoutMs: number;
  private readonly geocodeCache = new Map<
    string,
    CacheEntry<GeocodeResolution>
  >();
  private readonly forecastCache = new Map<
    string,
    CacheEntry<ScopedForecastData>
  >();
  private readonly inflightGeocodes = new Map<
    string,
    Promise<GeocodeResolution>
  >();
  private readonly inflightForecasts = new Map<
    string,
    Promise<ScopedForecastData>
  >();
  private rateLimitedUntilMs = 0;

  constructor(options?: {
    fetchImpl?: FetchLike;
    nowFn?: () => number;
    timeoutMs?: number;
  }) {
    this.fetchImpl = options?.fetchImpl ?? fetch;
    this.nowFn = options?.nowFn ?? (() => Date.now());
    this.timeoutMs = options?.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  private setBoundedCache<T>(
    cache: Map<string, CacheEntry<T>>,
    key: string,
    value: T,
    ttlMs: number
  ): void {
    if (cache.size >= MAX_CACHE_ENTRIES) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey !== undefined) {
        cache.delete(oldestKey);
      }
    }
    const now = this.nowFn();
    cache.set(key, { value, cachedAtMs: now, expiresAt: now + ttlMs });
  }

  private getRemainingCooldownSeconds(): number {
    const remainingMs = this.rateLimitedUntilMs - this.nowFn();
    return remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0;
  }

  async warmConnections(): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    try {
      await Promise.allSettled([
        this.fetchImpl(
          `${OPEN_METEO_GEOCODING_URL}?name=London&count=1&format=json`,
          { method: "GET", signal: controller.signal }
        ),
        this.fetchImpl(
          `${OPEN_METEO_FORECAST_URL}?latitude=51.51&longitude=-0.13&current=temperature_2m`,
          { method: "GET", signal: controller.signal }
        ),
      ]);
    } catch {
      // Best-effort pre-warm; ignore errors
    } finally {
      clearTimeout(timer);
    }
  }

  private async fetchJsonWithTimeout<T>(
    url: string,
    contextLabel: "geocoding" | "forecast"
  ): Promise<T> {
    const cooldownSec = this.getRemainingCooldownSeconds();
    if (cooldownSec > 0) {
      throw new WeatherServiceHttpError(
        "WEATHER_RATE_LIMITED",
        `Open-Meteo rate limit cooldown is active for another ${cooldownSec} seconds.`,
        cooldownSec
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (
        err instanceof Error &&
        (err.name === "AbortError" || /abort/i.test(err.message))
      ) {
        throw new WeatherServiceHttpError(
          contextLabel === "geocoding"
            ? "WEATHER_GEOCODING_FAILED"
            : "WEATHER_TIMEOUT",
          `The Open-Meteo ${contextLabel} request timed out after ${Math.round(this.timeoutMs / 1000)} seconds.`
        );
      }
      throw new WeatherServiceHttpError(
        contextLabel === "geocoding"
          ? "WEATHER_GEOCODING_FAILED"
          : "WEATHER_NETWORK_ERROR",
        `Unable to reach the Open-Meteo ${contextLabel} service due to a network error.`
      );
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 429) {
      const retryAfter = parseRetryAfterSeconds(
        response.headers?.get?.("retry-after") ?? null
      );
      const cooldownMs = Math.min(
        MAX_RATE_LIMIT_COOLDOWN_MS,
        Math.max(
          5000,
          retryAfter ? retryAfter * 1000 : DEFAULT_RATE_LIMIT_COOLDOWN_MS
        )
      );
      this.rateLimitedUntilMs = this.nowFn() + cooldownMs;
      const waitSec = Math.ceil(cooldownMs / 1000);
      throw new WeatherServiceHttpError(
        "WEATHER_RATE_LIMITED",
        `Open-Meteo temporarily rate-limited requests. Please wait about ${waitSec} seconds before retrying.`,
        waitSec
      );
    }

    if (!response.ok) {
      throw new WeatherServiceHttpError(
        contextLabel === "geocoding"
          ? "WEATHER_GEOCODING_FAILED"
          : "WEATHER_API_ERROR",
        `Open-Meteo ${contextLabel} returned HTTP ${response.status}.`
      );
    }

    try {
      return (await response.json()) as T;
    } catch {
      throw new WeatherServiceHttpError(
        contextLabel === "geocoding"
          ? "WEATHER_GEOCODING_FAILED"
          : "WEATHER_INVALID_RESPONSE",
        `Open-Meteo ${contextLabel} returned malformed JSON data.`
      );
    }
  }

  private async geocodeLocation(
    rawQuery: string
  ): Promise<{ resolution: GeocodeResolution; cacheHit: boolean }> {
    const normalizedKey = rawQuery.trim().toLowerCase().replace(/\s+/g, " ");
    const cached = this.geocodeCache.get(normalizedKey);
    if (cached && cached.expiresAt > this.nowFn()) {
      return { resolution: cached.value, cacheHit: true };
    }

    const inflight = this.inflightGeocodes.get(normalizedKey);
    if (inflight) {
      return { resolution: await inflight, cacheHit: true };
    }

    const task = (async (): Promise<GeocodeResolution> => {
      const { searchName, qualifierHint } = splitLocationQuery(rawQuery);
      const params = new URLSearchParams({
        name: searchName,
        count: "8",
        language: "en",
        format: "json",
      });

      const payload = await this.fetchJsonWithTimeout<{
        results?: unknown;
        error?: unknown;
        reason?: unknown;
      }>(`${OPEN_METEO_GEOCODING_URL}?${params.toString()}`, "geocoding");

      if (payload.error === true) {
        throw new WeatherServiceHttpError(
          "WEATHER_GEOCODING_FAILED",
          stringOrNull(payload.reason) ?? "Open-Meteo geocoding error."
        );
      }

      if (!Array.isArray(payload.results) || payload.results.length === 0) {
        return { kind: "not_found" };
      }

      const resolution = resolveGeocodeCandidates(
        payload.results as OpenMeteoGeocodeApiItem[],
        searchName,
        qualifierHint
      );

      if (resolution.kind !== "not_found") {
        this.setBoundedCache(
          this.geocodeCache,
          normalizedKey,
          resolution,
          GEOCODE_CACHE_TTL_MS
        );
      }
      return resolution;
    })();

    this.inflightGeocodes.set(normalizedKey, task);
    try {
      return { resolution: await task, cacheHit: false };
    } finally {
      this.inflightGeocodes.delete(normalizedKey);
    }
  }

  private buildValidatedScopedPayload(
    payload: OpenMeteoForecastPayload,
    scope: WeatherScope,
    fallbackTimeZone?: string
  ): ScopedForecastData {
    if (!payload || typeof payload !== "object") {
      throw new WeatherServiceHttpError(
        "WEATHER_INVALID_RESPONSE",
        "Open-Meteo forecast payload was empty or invalid."
      );
    }

    const currentRaw =
      payload.current && typeof payload.current === "object"
        ? payload.current
        : null;
    const hourlyRaw =
      payload.hourly && typeof payload.hourly === "object"
        ? payload.hourly
        : null;
    const dailyRaw =
      payload.daily && typeof payload.daily === "object" ? payload.daily : null;

    if (!currentRaw && !hourlyRaw && !dailyRaw) {
      throw new WeatherServiceHttpError(
        "WEATHER_INVALID_RESPONSE",
        "Open-Meteo forecast response is missing weather datasets."
      );
    }

    const timezone =
      stringOrNull(payload.timezone) ?? fallbackTimeZone ?? "UTC";
    const timezoneAbbreviation = stringOrNull(payload.timezone_abbreviation);
    const utcOffsetSeconds =
      typeof payload.utc_offset_seconds === "number" &&
      Number.isFinite(payload.utc_offset_seconds)
        ? Math.round(payload.utc_offset_seconds)
        : 0;

    const currentTimeLocal =
      stringOrNull(currentRaw?.time) ?? new Date(this.nowFn()).toISOString();

    let current: WeatherCurrentConditions | undefined;
    if (currentRaw) {
      const currentWeatherCode = roundIntOrNull(currentRaw.weather_code);
      const currentWindDegrees = roundIntOrNull(currentRaw.wind_direction_10m);
      current = {
        observedAtLocal: currentTimeLocal,
        condition: describeWmoWeatherCode(currentWeatherCode),
        weatherCode: currentWeatherCode,
        temperatureC: roundOneDecimalOrNull(currentRaw.temperature_2m),
        feelsLikeC: roundOneDecimalOrNull(currentRaw.apparent_temperature),
        humidityPercent: roundIntOrNull(currentRaw.relative_humidity_2m),
        windSpeedKmh: roundOneDecimalOrNull(currentRaw.wind_speed_10m),
        windDirectionDegrees: currentWindDegrees,
        windDirectionCardinal: degreesToCardinalDirection(currentWindDegrees),
        precipitationMm: roundOneDecimalOrNull(currentRaw.precipitation),
      };
    }

    let hourlyForecast: WeatherHourlyPoint[] | undefined;
    if (hourlyRaw) {
      const hourlyTimes = Array.isArray(hourlyRaw.time)
        ? (hourlyRaw.time as unknown[])
        : [];
      const currentHourPrefix = currentTimeLocal.slice(0, 13);
      let startIdx = hourlyTimes.findIndex(
        (t) => typeof t === "string" && t >= currentHourPrefix
      );
      if (startIdx < 0) startIdx = 0;

      const limit =
        scope === "precipitation"
          ? PRECIP_HOURLY_SLICE_LIMIT
          : HOURLY_SLICE_LIMIT;

      hourlyForecast = [];
      for (
        let i = startIdx;
        i < hourlyTimes.length && hourlyForecast.length < limit;
        i++
      ) {
        const timeLocal = stringOrNull(hourlyTimes[i]);
        if (!timeLocal) continue;
        const code = roundIntOrNull(arrayAt(hourlyRaw.weather_code, i));
        const windDeg = roundIntOrNull(arrayAt(hourlyRaw.wind_direction_10m, i));
        hourlyForecast.push({
          timeLocal,
          hourLabel: formatHourLabel(timeLocal),
          condition: describeWmoWeatherCode(code),
          weatherCode: code,
          temperatureC: roundOneDecimalOrNull(
            arrayAt(hourlyRaw.temperature_2m, i)
          ),
          feelsLikeC: roundOneDecimalOrNull(
            arrayAt(hourlyRaw.apparent_temperature, i)
          ),
          humidityPercent: roundIntOrNull(
            arrayAt(hourlyRaw.relative_humidity_2m, i)
          ),
          precipitationProbabilityPercent: roundIntOrNull(
            arrayAt(hourlyRaw.precipitation_probability, i)
          ),
          precipitationMm: roundOneDecimalOrNull(
            arrayAt(hourlyRaw.precipitation, i)
          ),
          windSpeedKmh: roundOneDecimalOrNull(
            arrayAt(hourlyRaw.wind_speed_10m, i)
          ),
          windDirectionCardinal: degreesToCardinalDirection(windDeg),
        });
      }
    }

    let dailyForecast: WeatherDailyPoint[] | undefined;
    if (dailyRaw) {
      const dailyDates = Array.isArray(dailyRaw.time)
        ? (dailyRaw.time as unknown[])
        : [];
      dailyForecast = [];
      for (
        let i = 0;
        i < dailyDates.length && dailyForecast.length < DAILY_SLICE_LIMIT;
        i++
      ) {
        const date = stringOrNull(dailyDates[i]);
        if (!date) continue;
        const code = roundIntOrNull(arrayAt(dailyRaw.weather_code, i));
        const windDeg = roundIntOrNull(
          arrayAt(dailyRaw.wind_direction_10m_dominant, i)
        );
        dailyForecast.push({
          date,
          dayOfWeek: formatDayOfWeek(date),
          condition: describeWmoWeatherCode(code),
          weatherCode: code,
          tempMaxC: roundOneDecimalOrNull(
            arrayAt(dailyRaw.temperature_2m_max, i)
          ),
          tempMinC: roundOneDecimalOrNull(
            arrayAt(dailyRaw.temperature_2m_min, i)
          ),
          precipitationProbabilityMaxPercent: roundIntOrNull(
            arrayAt(dailyRaw.precipitation_probability_max, i)
          ),
          precipitationSumMm: roundOneDecimalOrNull(
            arrayAt(dailyRaw.precipitation_sum, i)
          ),
          windSpeedMaxKmh: roundOneDecimalOrNull(
            arrayAt(dailyRaw.wind_speed_10m_max, i)
          ),
          windDirectionCardinal: degreesToCardinalDirection(windDeg),
        });
      }
    }

    const hasMeaningfulMetric =
      (current &&
        (current.temperatureC !== null ||
          current.weatherCode !== null ||
          current.precipitationMm !== null)) ||
      (hourlyForecast && hourlyForecast.length > 0) ||
      (dailyForecast && dailyForecast.length > 0);
    if (!hasMeaningfulMetric) {
      throw new WeatherServiceHttpError(
        "WEATHER_INVALID_RESPONSE",
        "Open-Meteo returned no valid temperature, condition, or forecast metrics."
      );
    }

    let precipitationSummary: WeatherPrecipitationSummary | undefined;
    if (
      scope === "precipitation" ||
      scope === "hourly" ||
      scope === "full" ||
      scope === "daily"
    ) {
      const next6HoursProbs = (hourlyForecast ?? [])
        .slice(0, 6)
        .map((h) => h.precipitationProbabilityPercent)
        .filter((v): v is number => v !== null);
      const next24HoursProbs = (hourlyForecast ?? [])
        .map((h) => h.precipitationProbabilityPercent)
        .filter((v): v is number => v !== null);
      const todayDaily = dailyForecast?.[0];
      precipitationSummary = {
        currentPrecipitationMm: current?.precipitationMm ?? null,
        next6HoursMaxProbabilityPercent:
          next6HoursProbs.length > 0 ? Math.max(...next6HoursProbs) : null,
        next24HoursMaxProbabilityPercent:
          next24HoursProbs.length > 0 ? Math.max(...next24HoursProbs) : null,
        todayTotalPrecipitationMm: todayDaily?.precipitationSumMm ?? null,
        todayMaxProbabilityPercent:
          todayDaily?.precipitationProbabilityMaxPercent ?? null,
      };
    }

    return {
      fetchedAt: new Date(this.nowFn()).toISOString(),
      timezone,
      timezoneAbbreviation,
      utcOffsetSeconds,
      current,
      precipitationSummary,
      hourlyForecast,
      dailyForecast,
    };
  }

  private lookupFreshScopedCache(
    coordKey: string,
    scope: WeatherScope
  ): { data: ScopedForecastData; cacheAgeSeconds: number } | null {
    const now = this.nowFn();

    // Direct match first
    const direct = this.forecastCache.get(`${coordKey}:${scope}`);
    if (direct && direct.expiresAt > now) {
      return {
        data: direct.value,
        cacheAgeSeconds: Math.max(0, Math.round((now - direct.cachedAtMs) / 1000)),
      };
    }

    // A fresh full fetch also satisfies narrower scopes cleanly within that scope's freshness window
    const fullEntry = this.forecastCache.get(`${coordKey}:full`);
    if (fullEntry) {
      const ageMs = now - fullEntry.cachedAtMs;
      const allowedTtl = getCacheTtlForScope(scope);
      if (ageMs >= 0 && ageMs < allowedTtl) {
        return {
          data: fullEntry.value,
          cacheAgeSeconds: Math.max(0, Math.round(ageMs / 1000)),
        };
      }
    }

    return null;
  }

  private projectScopedSuccess(options: {
    data: ScopedForecastData;
    resolvedName: string;
    resolvedFrom: "geocoding" | "device_geolocation";
    scope: WeatherScope;
    cached: boolean;
    cacheAgeSeconds: number;
  }): WeatherSuccessResult {
    const { data, resolvedName, resolvedFrom, scope, cached, cacheAgeSeconds } =
      options;

    const result: WeatherSuccessResult = {
      status: "ok",
      dataKind: "real_time_and_forecast",
      distinctionNote:
        "Use `current` strictly for conditions happening right now; use `hourlyForecast` and `dailyForecast` for upcoming predictions.",
      scope,
      fetchedAt: data.fetchedAt,
      cached,
      cacheAgeSeconds,
      location: {
        name: resolvedName,
        resolvedFrom,
        timezone: data.timezone,
        timezoneAbbreviation: data.timezoneAbbreviation,
        utcOffsetSeconds: data.utcOffsetSeconds,
      },
      units: {
        temperature: "°C",
        windSpeed: "km/h",
        precipitation: "mm",
        humidity: "%",
        precipitationProbability: "%",
      },
      attribution: OPEN_METEO_ATTRIBUTION,
    };

    if (data.current) {
      result.current = data.current;
    }
    if (
      data.precipitationSummary &&
      (scope === "precipitation" ||
        scope === "hourly" ||
        scope === "daily" ||
        scope === "full")
    ) {
      result.precipitationSummary = data.precipitationSummary;
    }
    if (
      data.hourlyForecast &&
      (scope === "hourly" || scope === "precipitation" || scope === "full")
    ) {
      result.hourlyForecast =
        scope === "precipitation"
          ? data.hourlyForecast.slice(0, PRECIP_HOURLY_SLICE_LIMIT)
          : data.hourlyForecast;
    }
    if (
      data.dailyForecast &&
      (scope === "daily" || scope === "precipitation" || scope === "full")
    ) {
      result.dailyForecast = data.dailyForecast;
    }

    return result;
  }

  private async fetchForecastForCoords(options: {
    latitude: number;
    longitude: number;
    resolvedName: string;
    resolvedFrom: "geocoding" | "device_geolocation";
    fallbackTimeZone?: string;
    scope: WeatherScope;
  }): Promise<{ result: WeatherSuccessResult; cacheHit: boolean }> {
    const roundedLat = roundCoordinate(options.latitude);
    const roundedLon = roundCoordinate(options.longitude);
    const coordKey = `${roundedLat.toFixed(2)},${roundedLon.toFixed(2)}`;
    const scopeKey = `${coordKey}:${options.scope}`;

    const cachedHit = this.lookupFreshScopedCache(coordKey, options.scope);
    if (cachedHit) {
      return {
        result: this.projectScopedSuccess({
          data: cachedHit.data,
          resolvedName: options.resolvedName,
          resolvedFrom: options.resolvedFrom,
          scope: options.scope,
          cached: true,
          cacheAgeSeconds: cachedHit.cacheAgeSeconds,
        }),
        cacheHit: true,
      };
    }

    const inflight =
      this.inflightForecasts.get(scopeKey) ??
      this.inflightForecasts.get(`${coordKey}:full`);
    if (inflight) {
      const data = await inflight;
      return {
        result: this.projectScopedSuccess({
          data,
          resolvedName: options.resolvedName,
          resolvedFrom: options.resolvedFrom,
          scope: options.scope,
          cached: true,
          cacheAgeSeconds: 0,
        }),
        cacheHit: true,
      };
    }

    const task = (async () => {
      const params = buildOpenMeteoForecastParams(
        roundedLat.toFixed(2),
        roundedLon.toFixed(2),
        options.scope
      );

      const payload = await this.fetchJsonWithTimeout<OpenMeteoForecastPayload>(
        `${OPEN_METEO_FORECAST_URL}?${params.toString()}`,
        "forecast"
      );

      if (
        payload &&
        typeof payload === "object" &&
        (payload as { error?: unknown }).error === true
      ) {
        throw new WeatherServiceHttpError(
          "WEATHER_API_ERROR",
          stringOrNull((payload as { reason?: unknown }).reason) ??
            "Open-Meteo forecast API reported an error."
        );
      }

      const validated = this.buildValidatedScopedPayload(
        payload,
        options.scope,
        options.fallbackTimeZone
      );
      this.setBoundedCache(
        this.forecastCache,
        scopeKey,
        validated,
        getCacheTtlForScope(options.scope)
      );
      return validated;
    })();

    this.inflightForecasts.set(scopeKey, task);
    try {
      const data = await task;
      return {
        result: this.projectScopedSuccess({
          data,
          resolvedName: options.resolvedName,
          resolvedFrom: options.resolvedFrom,
          scope: options.scope,
          cached: false,
          cacheAgeSeconds: 0,
        }),
        cacheHit: false,
      };
    } finally {
      this.inflightForecasts.delete(scopeKey);
    }
  }

  async executeWithMetrics(
    rawArgs: unknown,
    deps?: WeatherToolDependencies
  ): Promise<{ result: WeatherToolResult; metrics: WeatherExecutionMetrics }> {
    const startMs = performance.now();
    let geocodingMs = 0;
    let weatherRetrievalMs = 0;
    let responsePreparationMs = 0;
    let cacheHit = false;
    let geocodeCacheHit = false;

    const args =
      rawArgs && typeof rawArgs === "object"
        ? (rawArgs as Record<string, unknown>)
        : {};
    const locationQuery = stringOrNull(args.location);
    const scope = normalizeWeatherScope(args.scope);
    const wantsLocal = Boolean(args.useUserLocalLocation);

    const finalize = (result: WeatherToolResult) => {
      const totalMs = Math.round(performance.now() - startMs);
      return {
        result,
        metrics: {
          geocodingMs,
          weatherRetrievalMs,
          responsePreparationMs,
          totalMs,
          cacheHit,
          geocodeCacheHit,
          scope,
        },
      };
    };

    try {
      if (locationQuery && !wantsLocal) {
        const geoStart = performance.now();
        const geo = await this.geocodeLocation(locationQuery);
        geocodingMs = Math.round(performance.now() - geoStart);
        geocodeCacheHit = geo.cacheHit;

        if (geo.resolution.kind === "not_found") {
          return finalize({
            status: "not_found",
            query: locationQuery,
            scope,
            needsClarification: true,
            clarificationKind: "invalid_city",
            message: INVALID_CITY_SPOKEN_PROMPT,
            recommendedSpokenResponse: INVALID_CITY_SPOKEN_PROMPT,
            attribution: OPEN_METEO_ATTRIBUTION,
          });
        }

        if (geo.resolution.kind === "ambiguous") {
          const optionLabels = geo.resolution.candidates
            .map((c) => c.label)
            .join(", or ");
          const spoken = `I found a few places matching ${locationQuery}: ${optionLabels}. Which city did you mean?`;
          return finalize({
            status: "ambiguous",
            query: locationQuery,
            scope,
            needsClarification: true,
            clarificationKind: "ambiguous_city",
            candidates: geo.resolution.candidates,
            message: spoken,
            recommendedSpokenResponse: spoken,
            attribution: OPEN_METEO_ATTRIBUTION,
          });
        }

        const weatherStart = performance.now();
        const fetched = await this.fetchForecastForCoords({
          latitude: geo.resolution.place.latitude,
          longitude: geo.resolution.place.longitude,
          resolvedName: geo.resolution.place.name,
          resolvedFrom: "geocoding",
          fallbackTimeZone: geo.resolution.place.timezone,
          scope,
        });
        const prepStart = performance.now();
        weatherRetrievalMs = Math.round(prepStart - weatherStart);
        cacheHit = fetched.cacheHit;
        responsePreparationMs = Math.round(performance.now() - prepStart);
        return finalize(fetched.result);
      }

      if (wantsLocal) {
        if (!deps?.resolveLocalLocation) {
          const prompt = "Which city would you like me to check the weather for?";
          return finalize({
            status: "location_unavailable",
            scope,
            needsClarification: true,
            clarificationKind: "missing_location",
            message: prompt,
            recommendedSpokenResponse: prompt,
            attribution: OPEN_METEO_ATTRIBUTION,
          });
        }

        const geoStart = performance.now();
        const local = await deps.resolveLocalLocation();
        geocodingMs = Math.round(performance.now() - geoStart);

        if (local.status === "denied") {
          const prompt =
            "I don't have access to your device location right now. Which city would you like me to check?";
          return finalize({
            status: "location_permission_denied",
            scope,
            needsClarification: true,
            clarificationKind: "missing_location",
            message: prompt,
            recommendedSpokenResponse: prompt,
            attribution: OPEN_METEO_ATTRIBUTION,
          });
        }
        if (
          local.status !== "granted" ||
          !Number.isFinite(local.latitude) ||
          !Number.isFinite(local.longitude)
        ) {
          const prompt =
            "I couldn't determine your current location. Which city would you like me to check?";
          return finalize({
            status: "location_unavailable",
            scope,
            needsClarification: true,
            clarificationKind: "missing_location",
            message: prompt,
            recommendedSpokenResponse: prompt,
            attribution: OPEN_METEO_ATTRIBUTION,
          });
        }

        const weatherStart = performance.now();
        const fetched = await this.fetchForecastForCoords({
          latitude: local.latitude,
          longitude: local.longitude,
          resolvedName: "Your current area",
          resolvedFrom: "device_geolocation",
          fallbackTimeZone: deps.fallbackTimeZone,
          scope,
        });
        const prepStart = performance.now();
        weatherRetrievalMs = Math.round(prepStart - weatherStart);
        cacheHit = fetched.cacheHit;
        responsePreparationMs = Math.round(performance.now() - prepStart);
        return finalize(fetched.result);
      }

      const missingPrompt =
        "Which city would you like me to check the weather for?";
      return finalize({
        status: "missing_location",
        scope,
        needsClarification: true,
        clarificationKind: "missing_location",
        message: missingPrompt,
        recommendedSpokenResponse: missingPrompt,
        attribution: OPEN_METEO_ATTRIBUTION,
      });
    } catch (err) {
      if (err instanceof WeatherServiceHttpError) {
        const spoken =
          err.code === "WEATHER_RATE_LIMITED"
            ? `The weather service hit a brief rate limit. Let's try again in about ${err.retryAfterSeconds ?? 30} seconds.`
            : err.code === "WEATHER_TIMEOUT"
            ? "The weather service took too long to respond right now. Please try again in a moment."
            : err.code === "WEATHER_GEOCODING_FAILED"
            ? "I'm having trouble reaching the city lookup service right now, so I couldn't check that weather."
            : "I'm having trouble reaching the weather service right now, so I can't fetch updated conditions at the moment.";
        return finalize({
          status: "error",
          errorCode: err.code,
          query: locationQuery ?? "local",
          scope,
          message: err.message,
          recommendedSpokenResponse: spoken,
          retryAfterSeconds: err.retryAfterSeconds,
          attribution: OPEN_METEO_ATTRIBUTION,
        });
      }
      const fallbackSpoken =
        "Something went wrong while fetching the weather right now. Please try again in a moment.";
      return finalize({
        status: "error",
        errorCode: "WEATHER_API_ERROR",
        query: locationQuery ?? "local",
        scope,
        message:
          err instanceof Error
            ? err.message
            : "Weather lookup failed unexpectedly.",
        recommendedSpokenResponse: fallbackSpoken,
        attribution: OPEN_METEO_ATTRIBUTION,
      });
    }
  }

  async execute(
    rawArgs: unknown,
    deps?: WeatherToolDependencies
  ): Promise<WeatherToolResult> {
    const { result } = await this.executeWithMetrics(rawArgs, deps);
    return result;
  }
}

let defaultWeatherCoordinator: WeatherCoordinator | null = null;

export function getDefaultWeatherCoordinator(): WeatherCoordinator {
  if (!defaultWeatherCoordinator) {
    defaultWeatherCoordinator = new WeatherCoordinator();
  }
  return defaultWeatherCoordinator;
}

export async function executeWeatherTool(
  rawArgs: unknown,
  deps?: WeatherToolDependencies
): Promise<WeatherToolResult> {
  return getDefaultWeatherCoordinator().execute(rawArgs, deps);
}

export async function executeWeatherToolWithMetrics(
  rawArgs: unknown,
  deps?: WeatherToolDependencies
): Promise<{ result: WeatherToolResult; metrics: WeatherExecutionMetrics }> {
  return getDefaultWeatherCoordinator().executeWithMetrics(rawArgs, deps);
}

export function warmWeatherConnections(): void {
  void getDefaultWeatherCoordinator().warmConnections();
}

export interface PendingWeatherClarification {
  kind: WeatherClarificationKind;
  scope: WeatherScope;
  originalQuery?: string;
  candidates?: WeatherLocationCandidate[];
  createdAtMs: number;
}

const CLARIFICATION_EXPIRY_MS = 3 * 60 * 1000;

export function resolveWeatherArgsWithClarification(
  rawArgs: unknown,
  pending: PendingWeatherClarification | null,
  nowMs: number = Date.now()
): Record<string, unknown> {
  const args =
    rawArgs && typeof rawArgs === "object"
      ? { ...(rawArgs as Record<string, unknown>) }
      : {};

  if (!pending || nowMs - pending.createdAtMs > CLARIFICATION_EXPIRY_MS) {
    return args;
  }

  // Preserve original requested weather scope when follow-up omits or defaults scope
  if (
    (!args.scope || args.scope === "full") &&
    pending.scope &&
    pending.scope !== "full"
  ) {
    args.scope = pending.scope;
  }

  const rawLocation =
    typeof args.location === "string" ? args.location.trim() : "";
  if (
    rawLocation &&
    pending.kind === "ambiguous_city" &&
    pending.candidates &&
    pending.candidates.length > 0
  ) {
    const lowerLoc = rawLocation.toLowerCase();
    const baseCityLower = (
      pending.candidates[0]?.name ||
      pending.originalQuery ||
      ""
    ).toLowerCase();

    // If user answered only with state/region/country (e.g. "Illinois" or "Oregon") after Springfield/Portland ambiguity
    if (baseCityLower && !lowerLoc.includes(baseCityLower)) {
      const matchedCandidate = pending.candidates.find((c) => {
        const hay = [c.region ?? "", c.country ?? "", c.label]
          .join(" ")
          .toLowerCase();
        return hay.includes(lowerLoc);
      });
      if (matchedCandidate) {
        args.location = matchedCandidate.label;
      }
    }
  }

  return args;
}

export function buildClarificationUpdateFromResult(
  result: WeatherToolResult,
  nowMs: number = Date.now()
): PendingWeatherClarification | null {
  switch (result.status) {
    case "not_found":
      return {
        kind: "invalid_city",
        scope: result.scope,
        originalQuery: result.query,
        createdAtMs: nowMs,
      };
    case "ambiguous":
      return {
        kind: "ambiguous_city",
        scope: result.scope,
        originalQuery: result.query,
        candidates: result.candidates,
        createdAtMs: nowMs,
      };
    case "missing_location":
    case "location_permission_denied":
    case "location_unavailable":
      return {
        kind: "missing_location",
        scope: result.scope,
        createdAtMs: nowMs,
      };
    case "ok":
    case "error":
      return null;
  }
}

export function buildWeatherSilentTurnRecoveryPrompt(
  result: WeatherToolResult
): string {
  switch (result.status) {
    case "not_found":
      return `[SYSTEM EVENT: WEATHER_SPEAK_REQUIRED] The city "${result.query}" was not found. Speak aloud warmly and clearly right now: "${INVALID_CITY_SPOKEN_PROMPT}" Then pause and listen.`;
    case "ambiguous": {
      const options = result.candidates.map((c) => c.label).join(", or ");
      return `[SYSTEM EVENT: WEATHER_SPEAK_REQUIRED] Multiple cities matched "${result.query}". Ask aloud briefly right now which one the user meant (${options}), then pause and listen.`;
    }
    case "missing_location":
    case "location_permission_denied":
    case "location_unavailable":
      return `[SYSTEM EVENT: WEATHER_SPEAK_REQUIRED] No weather city is available yet. Politely ask aloud right now: "${result.recommendedSpokenResponse}" Then pause and listen.`;
    case "error":
      return `[SYSTEM EVENT: WEATHER_SPEAK_REQUIRED] The weather request failed (${result.errorCode}). Speak aloud briefly and honestly right now without guessing weather data: "${result.recommendedSpokenResponse}" Then pause and listen.`;
    case "ok":
      return `[SYSTEM EVENT: WEATHER_SPEAK_REQUIRED] You just received verified weather data for ${result.location.name}. Speak a concise, natural summary right now using Celsius, km/h, and mm, then pause and listen.`;
  }
}

export class WeatherToolTurnMonitor {
  private pendingClarification: PendingWeatherClarification | null = null;
  private clarificationSetThisTurn = false;
  private pendingFallback: { prompt: string; attempted: boolean } | null = null;
  private emittedAudioSinceToolResponse = false;
  private lastToolResponseSentAtMs: number | null = null;

  getPendingClarification(): PendingWeatherClarification | null {
    return this.pendingClarification;
  }

  prepareWeatherArgs(
    rawArgs: unknown,
    nowMs: number = Date.now()
  ): Record<string, unknown> {
    return resolveWeatherArgsWithClarification(
      rawArgs,
      this.pendingClarification,
      nowMs
    );
  }

  onWeatherToolResponseSent(
    result: WeatherToolResult,
    nowMs: number = Date.now()
  ): void {
    const nextClarification = buildClarificationUpdateFromResult(result, nowMs);
    this.pendingClarification = nextClarification;
    this.clarificationSetThisTurn = nextClarification !== null;
    this.pendingFallback = {
      prompt: buildWeatherSilentTurnRecoveryPrompt(result),
      attempted: false,
    };
    this.emittedAudioSinceToolResponse = false;
    this.lastToolResponseSentAtMs = nowMs;
  }

  onFirstModelAudioChunk(nowMs: number = Date.now()): number | null {
    this.emittedAudioSinceToolResponse = true;
    this.pendingFallback = null;
    if (this.lastToolResponseSentAtMs === null) {
      return null;
    }
    const handoffMs = Math.max(0, nowMs - this.lastToolResponseSentAtMs);
    this.lastToolResponseSentAtMs = null;
    return handoffMs;
  }

  onInterrupted(): void {
    this.pendingFallback = null;
    this.lastToolResponseSentAtMs = null;
  }

  onTurnComplete():
    | { action: "trigger_recovery"; prompt: string }
    | { action: "complete_turn" } {
    if (
      this.pendingFallback &&
      !this.pendingFallback.attempted &&
      !this.emittedAudioSinceToolResponse
    ) {
      this.pendingFallback.attempted = true;
      this.lastToolResponseSentAtMs = Date.now();
      return {
        action: "trigger_recovery",
        prompt: this.pendingFallback.prompt,
      };
    }

    this.pendingFallback = null;
    this.lastToolResponseSentAtMs = null;
    if (!this.clarificationSetThisTurn) {
      this.pendingClarification = null;
    }
    this.clarificationSetThisTurn = false;
    return { action: "complete_turn" };
  }
}


