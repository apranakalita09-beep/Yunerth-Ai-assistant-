import assert from "node:assert/strict";
import { buildYunerthOrchestrationInstruction } from "./orchestration.ts";
import {
  CURRENT_WEATHER_CACHE_TTL_MS,
  degreesToCardinalDirection,
  describeWmoWeatherCode,
  FORECAST_WEATHER_CACHE_TTL_MS,
  INVALID_CITY_SPOKEN_PROMPT,
  roundCoordinate,
  WeatherCoordinator,
  WeatherToolTurnMonitor,
  type FetchLike,
} from "./weatherService.ts";

function buildMockForecastPayload(overrides?: {
  timezone?: string;
  timezoneAbbreviation?: string;
  utcOffsetSeconds?: number;
  currentTime?: string;
  weatherCode?: number | null;
  temperatureC?: number | null;
  feelsLikeC?: number | null;
  humidity?: number | null;
  windSpeed?: number | null;
  windDir?: number | null;
  precipitationMm?: number | null;
  includeHourly?: boolean;
  includeDaily?: boolean;
}) {
  const tz = overrides?.timezone ?? "America/Los_Angeles";
  const tzAbbr = overrides?.timezoneAbbreviation ?? "PST";
  const utcOffset = overrides?.utcOffsetSeconds ?? -28800;
  const currentTime = overrides?.currentTime ?? "2026-11-22T09:15";

  const payload: Record<string, unknown> = {
    latitude: 37.77,
    longitude: -122.42,
    utc_offset_seconds: utcOffset,
    timezone: tz,
    timezone_abbreviation: tzAbbr,
    current: {
      time: currentTime,
      temperature_2m:
        overrides?.temperatureC !== undefined ? overrides.temperatureC : 15.4,
      relative_humidity_2m:
        overrides?.humidity !== undefined ? overrides.humidity : 72,
      apparent_temperature:
        overrides?.feelsLikeC !== undefined ? overrides.feelsLikeC : 14.1,
      precipitation:
        overrides?.precipitationMm !== undefined
          ? overrides.precipitationMm
          : 0.0,
      weather_code:
        overrides?.weatherCode !== undefined ? overrides.weatherCode : 2,
      wind_speed_10m:
        overrides?.windSpeed !== undefined ? overrides.windSpeed : 18.6,
      wind_direction_10m:
        overrides?.windDir !== undefined ? overrides.windDir : 315,
    },
  };

  if (overrides?.includeHourly !== false) {
    const hourlyTimes: string[] = [];
    const hourlyTemps: Array<number | null> = [];
    const hourlyFeels: Array<number | null> = [];
    const hourlyHumidity: Array<number | null> = [];
    const hourlyPrecipProb: Array<number | null> = [];
    const hourlyPrecip: Array<number | null> = [];
    const hourlyCodes: Array<number | null> = [];
    const hourlyWind: Array<number | null> = [];
    const hourlyWindDir: Array<number | null> = [];

    for (let h = 0; h < 36; h++) {
      const dayOffset = Math.floor(h / 24);
      const day = 22 + dayOffset;
      const hour = h % 24;
      hourlyTimes.push(
        `2026-11-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00`
      );
      hourlyTemps.push(14 + (h % 8));
      hourlyFeels.push(13 + (h % 8));
      hourlyHumidity.push(65 + (h % 15));
      hourlyPrecipProb.push(h === 11 ? 75 : 20);
      hourlyPrecip.push(h === 11 ? 1.8 : 0.0);
      hourlyCodes.push(h === 11 ? 61 : 2);
      hourlyWind.push(12 + (h % 6));
      hourlyWindDir.push(270);
    }

    payload.hourly = {
      time: hourlyTimes,
      temperature_2m: hourlyTemps,
      apparent_temperature: hourlyFeels,
      relative_humidity_2m: hourlyHumidity,
      precipitation_probability: hourlyPrecipProb,
      precipitation: hourlyPrecip,
      weather_code: hourlyCodes,
      wind_speed_10m: hourlyWind,
      wind_direction_10m: hourlyWindDir,
    };
  }

  if (overrides?.includeDaily !== false) {
    payload.daily = {
      time: [
        "2026-11-22",
        "2026-11-23",
        "2026-11-24",
        "2026-11-25",
        "2026-11-26",
        "2026-11-27",
        "2026-11-28",
      ],
      weather_code: [2, 61, 3, 1, 0, 80, 2],
      temperature_2m_max: [17.2, 15.8, 16.0, 18.5, 19.1, 14.9, 16.4],
      temperature_2m_min: [9.8, 10.2, 8.9, 9.4, 10.1, 8.5, 9.0],
      precipitation_sum: [0.4, 6.2, 0.0, 0.0, 0.0, 4.1, 0.2],
      precipitation_probability_max: [35, 85, 15, 5, 0, 70, 20],
      wind_speed_10m_max: [21.3, 28.4, 16.0, 14.2, 11.8, 25.0, 17.6],
      wind_direction_10m_dominant: [315, 225, 270, 300, 10, 240, 290],
    };
  }

  return payload;
}

function makeJsonResponse(
  body: unknown,
  status = 200,
  headers?: Record<string, string>
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...(headers ?? {}),
    },
  });
}

async function runTests(): Promise<void> {
  // 1. Valid city weather request (scoped Open-Meteo query + compact LLM payload + metrics + accuracy)
  {
    const requestedUrls: string[] = [];
    const coordinator = new WeatherCoordinator({
      fetchImpl: (async (input: RequestInfo | URL) => {
        const url = String(input);
        requestedUrls.push(url);
        if (url.includes("geocoding-api.open-meteo.com")) {
          return makeJsonResponse({
            results: [
              {
                name: "Tokyo",
                admin1: "Tokyo",
                country: "Japan",
                population: 9733276,
                feature_code: "PPLC",
                latitude: 35.6895,
                longitude: 139.6917,
                timezone: "Asia/Tokyo",
              },
            ],
          });
        }
        return makeJsonResponse(
          buildMockForecastPayload({
            timezone: "Asia/Tokyo",
            timezoneAbbreviation: "JST",
            utcOffsetSeconds: 32400,
            currentTime: "2026-11-22T15:15",
            includeHourly: false,
            includeDaily: false,
          })
        );
      }) as FetchLike,
    });

    const { result, metrics } = await coordinator.executeWithMetrics({
      location: "Tokyo",
      useUserLocalLocation: false,
      scope: "current",
    });

    assert.equal(result.status, "ok");
    if (result.status === "ok") {
      assert.equal(result.scope, "current");
      assert.equal(result.location.name, "Tokyo, Japan");
      assert.equal(result.location.timezone, "Asia/Tokyo");
      assert.equal(result.units.temperature, "°C");
      assert.equal(result.units.windSpeed, "km/h");
      assert.equal(result.units.precipitation, "mm");
      assert.equal(result.current?.condition, "Partly cloudy");
      assert.equal(result.current?.temperatureC, 15.4);
      assert.equal(result.current?.feelsLikeC, 14.1);
      assert.equal(result.current?.humidityPercent, 72);
      assert.equal(result.current?.windSpeedKmh, 18.6);
      assert.equal(result.current?.windDirectionCardinal, "NW");
      assert.equal(result.hourlyForecast, undefined);
      assert.equal(result.dailyForecast, undefined);
      assert.equal(result.attribution.provider, "Open-Meteo");
      assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") < 1200);
    }
    assert.equal(metrics.scope, "current");
    assert.equal(metrics.cacheHit, false);
    assert.equal(metrics.geocodeCacheHit, false);
    assert.equal(requestedUrls.length, 2);
    assert.doesNotMatch(requestedUrls[1], /&hourly=/);
    assert.doesNotMatch(requestedUrls[1], /&daily=/);
    assert.equal(roundCoordinate(37.774929), 37.77);
    assert.equal(describeWmoWeatherCode(95), "Thunderstorm");
    assert.equal(degreesToCardinalDirection(180), "S");
  }

  // 2. Invalid city request returns distinct status: "not_found" with exact spoken prompt
  {
    const coordinator = new WeatherCoordinator({
      fetchImpl: (async () => makeJsonResponse({})) as FetchLike,
    });
    const res = await coordinator.execute({
      location: "ZzzNonexistentCity999",
      scope: "current",
    });
    assert.equal(res.status, "not_found");
    if (res.status === "not_found") {
      assert.equal(res.needsClarification, true);
      assert.equal(res.clarificationKind, "invalid_city");
      assert.equal(res.recommendedSpokenResponse, INVALID_CITY_SPOKEN_PROMPT);
    }

    // Missing location without useUserLocalLocation returns missing_location (not API error)
    const missingRes = await coordinator.execute({ scope: "current" });
    assert.equal(missingRes.status, "missing_location");
  }

  // 3. Ambiguous city request (close population ties clarify; clear dominant cities auto-pick; comma qualifiers resolve in 1 hop)
  {
    let geoCalls = 0;
    const coordinator = new WeatherCoordinator({
      fetchImpl: (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("geocoding-api.open-meteo.com")) {
          geoCalls += 1;
          if (url.includes("name=Springfield")) {
            return makeJsonResponse({
              results: [
                {
                  name: "Springfield",
                  admin1: "Missouri",
                  country: "United States",
                  country_code: "US",
                  population: 170188,
                  feature_code: "PPLA2",
                  latitude: 37.2153,
                  longitude: -93.2982,
                  timezone: "America/Chicago",
                },
                {
                  name: "Springfield",
                  admin1: "Massachusetts",
                  country: "United States",
                  country_code: "US",
                  population: 154341,
                  feature_code: "PPL",
                  latitude: 42.1015,
                  longitude: -72.5898,
                  timezone: "America/New_York",
                },
                {
                  name: "Springfield",
                  admin1: "Illinois",
                  country: "United States",
                  country_code: "US",
                  population: 114394,
                  feature_code: "PPLA",
                  latitude: 39.8017,
                  longitude: -89.6436,
                  timezone: "America/Chicago",
                },
              ],
            });
          }
          if (url.includes("name=London")) {
            return makeJsonResponse({
              results: [
                {
                  name: "London",
                  admin1: "England",
                  country: "United Kingdom",
                  population: 8961989,
                  feature_code: "PPLC",
                  latitude: 51.5085,
                  longitude: -0.1257,
                  timezone: "Europe/London",
                },
                {
                  name: "London",
                  admin1: "Ontario",
                  country: "Canada",
                  population: 422324,
                  feature_code: "PPL",
                  latitude: 42.9834,
                  longitude: -81.233,
                  timezone: "America/Toronto",
                },
              ],
            });
          }
          if (url.includes("name=Portland")) {
            return makeJsonResponse({
              results: [
                {
                  name: "Portland",
                  admin1: "Oregon",
                  country: "United States",
                  country_code: "US",
                  population: 652503,
                  feature_code: "PPLA2",
                  latitude: 45.5234,
                  longitude: -122.6762,
                  timezone: "America/Los_Angeles",
                },
                {
                  name: "Portland",
                  admin1: "Maine",
                  country: "United States",
                  country_code: "US",
                  population: 66881,
                  feature_code: "PPLA2",
                  latitude: 43.6591,
                  longitude: -70.2568,
                  timezone: "America/New_York",
                },
              ],
            });
          }
        }
        return makeJsonResponse(buildMockForecastPayload({ includeHourly: false, includeDaily: false }));
      }) as FetchLike,
    });

    const springfield = await coordinator.execute({
      location: "Springfield",
      scope: "current",
    });
    assert.equal(springfield.status, "ambiguous");
    if (springfield.status === "ambiguous") {
      assert.equal(springfield.clarificationKind, "ambiguous_city");
      assert.equal(springfield.candidates.length, 3);
      assert.match(springfield.candidates[0].label, /Springfield, Missouri/);
      assert.match(springfield.candidates[2].label, /Springfield, Illinois/);
    }

    // Dominant metropolis auto-resolves
    const london = await coordinator.execute({
      location: "London",
      scope: "current",
    });
    assert.equal(london.status, "ok");
    if (london.status === "ok") {
      assert.match(london.location.name, /United Kingdom/);
    }

    // Comma qualifier ("Portland, Maine") resolves in ONE geocoding HTTP request (not 2 sequential hops)
    const geoBefore = geoCalls;
    const portlandMaine = await coordinator.execute({
      location: "Portland, Maine",
      scope: "current",
    });
    assert.equal(geoCalls - geoBefore, 1);
    assert.equal(portlandMaine.status, "ok");
    if (portlandMaine.status === "ok") {
      assert.equal(portlandMaine.location.name, "Portland, Maine, United States");
    }
  }

  // 4. User provides corrected city after clarification (bare "Guwahati" and region "Illinois" follow-up)
  {
    const coordinator = new WeatherCoordinator({
      fetchImpl: (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("geocoding-api.open-meteo.com")) {
          if (url.includes("name=Guwahati")) {
            return makeJsonResponse({
              results: [
                {
                  name: "Guwahati",
                  admin1: "Assam",
                  country: "India",
                  population: 962334,
                  feature_code: "PPL",
                  latitude: 26.1862,
                  longitude: 91.7458,
                  timezone: "Asia/Kolkata",
                },
              ],
            });
          }
          if (url.includes("name=Springfield")) {
            return makeJsonResponse({
              results: [
                {
                  name: "Springfield",
                  admin1: "Missouri",
                  country: "United States",
                  population: 170188,
                  feature_code: "PPLA2",
                  latitude: 37.2153,
                  longitude: -93.2982,
                  timezone: "America/Chicago",
                },
                {
                  name: "Springfield",
                  admin1: "Illinois",
                  country: "United States",
                  population: 114394,
                  feature_code: "PPLA",
                  latitude: 39.8017,
                  longitude: -89.6436,
                  timezone: "America/Chicago",
                },
              ],
            });
          }
          return makeJsonResponse({ results: [] });
        }
        return makeJsonResponse(
          buildMockForecastPayload({
            timezone: "Asia/Kolkata",
            temperatureC: 24.5,
          })
        );
      }) as FetchLike,
    });

    const monitor = new WeatherToolTurnMonitor();
    const invalidRes = await coordinator.execute({
      location: "XyzzyFake",
      scope: "daily",
    });
    assert.equal(invalidRes.status, "not_found");
    monitor.onWeatherToolResponseSent(invalidRes);
    monitor.onFirstModelAudioChunk(); // Yunerth asked: "I couldn't find that city..."
    assert.deepEqual(monitor.onTurnComplete(), { action: "complete_turn" });
    assert.equal(monitor.getPendingClarification()?.kind, "invalid_city");
    assert.equal(monitor.getPendingClarification()?.scope, "daily");

    // User answers simply "Guwahati" -> monitor preserves original "daily" scope automatically
    const correctedArgs = monitor.prepareWeatherArgs({ location: "Guwahati" });
    assert.equal(correctedArgs.scope, "daily");
    const guwahatiRes = await coordinator.execute(correctedArgs);
    assert.equal(guwahatiRes.status, "ok");
    if (guwahatiRes.status === "ok") {
      assert.equal(guwahatiRes.location.name, "Guwahati, Assam, India");
      assert.equal(guwahatiRes.scope, "daily");
      assert.equal(guwahatiRes.dailyForecast?.length, 7);
    }
    monitor.onWeatherToolResponseSent(guwahatiRes);
    monitor.onFirstModelAudioChunk();
    assert.deepEqual(monitor.onTurnComplete(), { action: "complete_turn" });
    assert.equal(monitor.getPendingClarification(), null);

    // Ambiguous Springfield -> user replies simply "Illinois" -> monitor expands to Springfield, Illinois, United States
    const ambRes = await coordinator.execute({
      location: "Springfield",
      scope: "hourly",
    });
    assert.equal(ambRes.status, "ambiguous");
    monitor.onWeatherToolResponseSent(ambRes);
    monitor.onFirstModelAudioChunk();
    monitor.onTurnComplete();
    const regionArgs = monitor.prepareWeatherArgs({ location: "Illinois" });
    assert.equal(regionArgs.location, "Springfield, Illinois, United States");
    assert.equal(regionArgs.scope, "hourly");
  }

  // 5. Geocoding API failure (distinguished cleanly from invalid city)
  {
    const geoFailCoord = new WeatherCoordinator({
      fetchImpl: (async (input: RequestInfo | URL) => {
        if (String(input).includes("geocoding-api.open-meteo.com")) {
          return new Response("Upstream Bad Gateway", { status: 502 });
        }
        throw new Error("Should not call forecast if geocoding failed");
      }) as FetchLike,
    });
    const res = await geoFailCoord.execute({
      location: "Guwahati",
      scope: "current",
    });
    assert.equal(res.status, "error");
    if (res.status === "error") {
      assert.equal(res.errorCode, "WEATHER_GEOCODING_FAILED");
      assert.match(res.recommendedSpokenResponse, /city lookup service/i);
    }
  }

  // 6. Weather API timeout, network failure, 429 rate-limit, and invalid JSON
  {
    const timeoutCoord = new WeatherCoordinator({
      timeoutMs: 25,
      fetchImpl: ((url: RequestInfo | URL, init?: RequestInit) => {
        if (String(url).includes("geocoding-api.open-meteo.com")) {
          return Promise.resolve(
            makeJsonResponse({
              results: [
                {
                  name: "Tokyo",
                  country: "Japan",
                  latitude: 35.69,
                  longitude: 139.69,
                  timezone: "Asia/Tokyo",
                },
              ],
            })
          );
        }
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("Aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      }) as FetchLike,
    });
    const timeoutRes = await timeoutCoord.execute({
      location: "Tokyo",
      scope: "current",
    });
    assert.equal(timeoutRes.status, "error");
    if (timeoutRes.status === "error") {
      assert.equal(timeoutRes.errorCode, "WEATHER_TIMEOUT");
    }

    let rateCalls = 0;
    const rateCoord = new WeatherCoordinator({
      fetchImpl: (async (url: RequestInfo | URL) => {
        if (String(url).includes("geocoding-api.open-meteo.com")) {
          return makeJsonResponse({
            results: [
              {
                name: "Tokyo",
                country: "Japan",
                latitude: 35.69,
                longitude: 139.69,
                timezone: "Asia/Tokyo",
              },
            ],
          });
        }
        rateCalls += 1;
        return new Response("Too Many Requests", {
          status: 429,
          headers: { "Retry-After": "12" },
        });
      }) as FetchLike,
    });
    const r1 = await rateCoord.execute({ location: "Tokyo", scope: "current" });
    const r2 = await rateCoord.execute({ location: "Tokyo", scope: "daily" });
    assert.equal(r1.status, "error");
    assert.equal(r2.status, "error");
    if (r1.status === "error") {
      assert.equal(r1.errorCode, "WEATHER_RATE_LIMITED");
      assert.equal(r1.retryAfterSeconds, 12);
    }
    assert.equal(rateCalls, 1);

    const malformedCoord = new WeatherCoordinator({
      fetchImpl: (async () =>
        new Response("{bad-json", { status: 200 })) as FetchLike,
    });
    const malformedRes = await malformedCoord.execute(
      { useUserLocalLocation: true, scope: "current" },
      {
        resolveLocalLocation: async () => ({
          status: "granted",
          latitude: 10,
          longitude: 20,
        }),
      }
    );
    assert.equal(malformedRes.status, "error");
    if (malformedRes.status === "error") {
      assert.equal(malformedRes.errorCode, "WEATHER_INVALID_RESPONSE");
    }
  }

  // 7 & 8. Repeated requests for the same city + Split 2-minute current vs 10-minute forecast cache freshness & timestamps
  {
    let geocodeCalls = 0;
    let forecastCalls = 0;
    let fakeNow = 10_000_000;

    const coordinator = new WeatherCoordinator({
      nowFn: () => fakeNow,
      fetchImpl: (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("geocoding-api.open-meteo.com")) {
          geocodeCalls += 1;
          await new Promise((r) => setTimeout(r, 10));
          return makeJsonResponse({
            results: [
              {
                name: "Guwahati",
                admin1: "Assam",
                country: "India",
                population: 962334,
                feature_code: "PPL",
                latitude: 26.19,
                longitude: 91.75,
                timezone: "Asia/Kolkata",
              },
            ],
          });
        }
        forecastCalls += 1;
        await new Promise((r) => setTimeout(r, 10));
        return makeJsonResponse(
          buildMockForecastPayload({ timezone: "Asia/Kolkata" })
        );
      }) as FetchLike,
    });

    // Concurrent identical requests coalesce
    const [a, b] = await Promise.all([
      coordinator.executeWithMetrics({ location: "Guwahati", scope: "current" }),
      coordinator.executeWithMetrics({ location: "Guwahati", scope: "current" }),
    ]);
    assert.equal(a.result.status, "ok");
    assert.equal(b.result.status, "ok");
    assert.equal(geocodeCalls, 1);
    assert.equal(forecastCalls, 1);

    // Within 2 minutes -> current cache hit with accurate cacheAgeSeconds
    fakeNow += 45_000;
    const warmCurrent = await coordinator.executeWithMetrics({
      location: "Guwahati",
      scope: "current",
    });
    assert.equal(warmCurrent.metrics.geocodeCacheHit, true);
    assert.equal(warmCurrent.metrics.cacheHit, true);
    if (warmCurrent.result.status === "ok") {
      assert.equal(warmCurrent.result.cacheAgeSeconds, 45);
      assert.ok(warmCurrent.result.fetchedAt);
      assert.ok(warmCurrent.result.current?.observedAtLocal);
    }
    assert.equal(geocodeCalls, 1);
    assert.equal(forecastCalls, 1);

    // Fetch 7-day daily forecast once
    const daily1 = await coordinator.executeWithMetrics({
      location: "Guwahati",
      scope: "daily",
    });
    assert.equal(daily1.result.status, "ok");
    assert.equal(geocodeCalls, 1);
    assert.equal(forecastCalls, 2);

    // Advance 3 minutes (> 2m current TTL, < 10m forecast TTL)
    fakeNow += CURRENT_WEATHER_CACHE_TTL_MS + 1000;
    const expiredCurrent = await coordinator.executeWithMetrics({
      location: "Guwahati",
      scope: "current",
    });
    assert.equal(expiredCurrent.metrics.cacheHit, false); // current refetched fresh!
    assert.equal(forecastCalls, 3);

    // Daily forecast is still fresh (< 10m forecast TTL)!
    const stillFreshDaily = await coordinator.executeWithMetrics({
      location: "Guwahati",
      scope: "daily",
    });
    assert.equal(stillFreshDaily.metrics.cacheHit, true);
    assert.equal(forecastCalls, 3);

    // Advance past 10m forecast TTL -> daily forecast refetches fresh
    fakeNow += FORECAST_WEATHER_CACHE_TTL_MS + 1000;
    const expiredDaily = await coordinator.executeWithMetrics({
      location: "Guwahati",
      scope: "daily",
    });
    assert.equal(expiredDaily.metrics.cacheHit, false);
    assert.equal(forecastCalls, 4);
    assert.equal(geocodeCalls, 1); // 24h coordinate cache still warm!
  }

  // 9. Normal conversation after weather errors
  {
    const monitor = new WeatherToolTurnMonitor();
    monitor.onWeatherToolResponseSent({
      status: "not_found",
      query: "BadCity",
      scope: "current",
      needsClarification: true,
      clarificationKind: "invalid_city",
      message: INVALID_CITY_SPOKEN_PROMPT,
      recommendedSpokenResponse: INVALID_CITY_SPOKEN_PROMPT,
      attribution: {
        provider: "Open-Meteo",
        url: "https://open-meteo.com/",
        notice: "Weather data by Open-Meteo.com",
        geocodingNotice: "Location lookup via Open-Meteo Geocoding / GeoNames",
      },
    });
    monitor.onFirstModelAudioChunk();
    monitor.onTurnComplete(); // Clarification turn finishes
    assert.ok(monitor.getPendingClarification());

    // User ignores clarification and talks normally -> non-weather turn completes
    assert.deepEqual(monitor.onTurnComplete(), { action: "complete_turn" });
    assert.equal(monitor.getPendingClarification(), null);

    const instruction = buildYunerthOrchestrationInstruction("Asia/Kolkata");
    assert.match(instruction, /Stage 4\.1 Real-Time World Clock/);
    assert.match(instruction, /Stage 4\.2 Live Web Search/);
    assert.match(instruction, /Clarification follow-up continuity/);
    assert.match(instruction, /I couldn't find that city\. Could you please tell me the correct city name\?/);
  }

  // 10. Voice response after failed weather requests (Silent-turn recovery guarantee)
  {
    const monitor = new WeatherToolTurnMonitor();
    const coordinator = new WeatherCoordinator({
      fetchImpl: (async () => makeJsonResponse({ results: [] })) as FetchLike,
    });
    const notFound = await coordinator.execute({
      location: "NowhereCity",
      scope: "current",
    });
    assert.equal(notFound.status, "not_found");

    // Server sends tool response; model silently sends turnComplete with 0 audio chunks
    monitor.onWeatherToolResponseSent(notFound, 1000);
    const silentDecision = monitor.onTurnComplete();
    assert.equal(silentDecision.action, "trigger_recovery");
    if (silentDecision.action === "trigger_recovery") {
      assert.match(
        silentDecision.prompt,
        /I couldn't find that city\. Could you please tell me the correct city name\?/
      );
    }

    // Recovery turn emits spoken audio and completes cleanly without looping
    const handoffMs = monitor.onFirstModelAudioChunk(1420);
    assert.ok(handoffMs !== null && handoffMs >= 0);
    assert.deepEqual(monitor.onTurnComplete(), { action: "complete_turn" });

    // API error also triggers spoken recovery once if model stayed silent
    monitor.onWeatherToolResponseSent({
      status: "error",
      errorCode: "WEATHER_TIMEOUT",
      query: "London",
      scope: "current",
      message: "Timed out",
      recommendedSpokenResponse:
        "The weather service took too long to respond right now. Please try again in a moment.",
      attribution: notFound.attribution,
    });
    const errorSilentDecision = monitor.onTurnComplete();
    assert.equal(errorSilentDecision.action, "trigger_recovery");
    if (errorSilentDecision.action === "trigger_recovery") {
      assert.match(errorSilentDecision.prompt, /WEATHER_TIMEOUT/);
    }
    // Never loops endlessly if even the recovery turn completes silently
    assert.deepEqual(monitor.onTurnComplete(), { action: "complete_turn" });
  }

  console.log("WEATHER_OPTIMIZATION_1_1_ALL_10_SCENARIOS: PASSED");
}

runTests().catch((err) => {
  console.error("WEATHER_SERVICE_TESTS_FAILED:", err);
  process.exit(1);
});
