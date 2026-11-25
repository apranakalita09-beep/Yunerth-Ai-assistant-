import { Type, type FunctionDeclaration } from "@google/genai";

export interface TimeZoneCandidate {
  label: string;
  ianaTimeZone: string;
}

export interface ResolvedWorldClock {
  status: "resolved";
  query: string;
  resolvedLabel: string;
  ianaTimeZone: string;
  time12Hour: string;
  time24Hour: string;
  weekday: string;
  dateFormatted: string;
  isoDate: string;
  utcOffset: string;
  offsetMinutes: number;
  observesDst: boolean;
  dstActive: boolean;
  timeZoneName: string;
}

export interface AmbiguousWorldClock {
  status: "ambiguous";
  query: string;
  message: string;
  candidates: TimeZoneCandidate[];
}

export interface NotFoundWorldClock {
  status: "not_found";
  query: string;
  message: string;
}

export type WorldClockLookupResult =
  | ResolvedWorldClock
  | AmbiguousWorldClock
  | NotFoundWorldClock;

export interface TimeDifferenceResolved {
  status: "resolved";
  locationA: ResolvedWorldClock;
  locationB: ResolvedWorldClock;
  differenceMinutes: number;
  absoluteDifferenceMinutes: number;
  differenceFormatted: string;
  relation: string;
  calendarDayDifference: string;
  summary: string;
}

export interface TimeDifferenceClarification {
  status: "ambiguous" | "not_found";
  locationQuery: string;
  message: string;
  candidates?: TimeZoneCandidate[];
}

export type TimeDifferenceResult =
  | TimeDifferenceResolved
  | TimeDifferenceClarification;

const AMBIGUOUS_LOCATIONS: Record<
  string,
  { message: string; candidates: TimeZoneCandidate[] }
> = {
  usa: {
    message:
      "The United States spans multiple time zones. Ask which city or time zone the user wants.",
    candidates: [
      { label: "New York (Eastern Time)", ianaTimeZone: "America/New_York" },
      { label: "Chicago (Central Time)", ianaTimeZone: "America/Chicago" },
      { label: "Denver (Mountain Time)", ianaTimeZone: "America/Denver" },
      { label: "Los Angeles (Pacific Time)", ianaTimeZone: "America/Los_Angeles" },
    ],
  },
  us: {
    message:
      "The United States spans multiple time zones. Ask which city or time zone the user wants.",
    candidates: [
      { label: "New York (Eastern Time)", ianaTimeZone: "America/New_York" },
      { label: "Chicago (Central Time)", ianaTimeZone: "America/Chicago" },
      { label: "Denver (Mountain Time)", ianaTimeZone: "America/Denver" },
      { label: "Los Angeles (Pacific Time)", ianaTimeZone: "America/Los_Angeles" },
    ],
  },
  "united states": {
    message:
      "The United States spans multiple time zones. Ask which city or time zone the user wants.",
    candidates: [
      { label: "New York (Eastern Time)", ianaTimeZone: "America/New_York" },
      { label: "Chicago (Central Time)", ianaTimeZone: "America/Chicago" },
      { label: "Denver (Mountain Time)", ianaTimeZone: "America/Denver" },
      { label: "Los Angeles (Pacific Time)", ianaTimeZone: "America/Los_Angeles" },
    ],
  },
  america: {
    message:
      "The United States spans multiple time zones. Ask which city or time zone the user wants.",
    candidates: [
      { label: "New York (Eastern Time)", ianaTimeZone: "America/New_York" },
      { label: "Chicago (Central Time)", ianaTimeZone: "America/Chicago" },
      { label: "Denver (Mountain Time)", ianaTimeZone: "America/Denver" },
      { label: "Los Angeles (Pacific Time)", ianaTimeZone: "America/Los_Angeles" },
    ],
  },
  canada: {
    message:
      "Canada spans multiple time zones. Ask which city or time zone the user wants.",
    candidates: [
      { label: "Toronto (Eastern Time)", ianaTimeZone: "America/Toronto" },
      { label: "Winnipeg (Central Time)", ianaTimeZone: "America/Winnipeg" },
      { label: "Calgary (Mountain Time)", ianaTimeZone: "America/Edmonton" },
      { label: "Vancouver (Pacific Time)", ianaTimeZone: "America/Vancouver" },
    ],
  },
  australia: {
    message:
      "Australia spans multiple time zones. Ask which city or time zone the user wants.",
    candidates: [
      { label: "Sydney / Melbourne (Eastern)", ianaTimeZone: "Australia/Sydney" },
      { label: "Brisbane (Queensland)", ianaTimeZone: "Australia/Brisbane" },
      { label: "Adelaide (Central)", ianaTimeZone: "Australia/Adelaide" },
      { label: "Perth (Western)", ianaTimeZone: "Australia/Perth" },
    ],
  },
  russia: {
    message:
      "Russia spans eleven time zones. Ask which city or region the user wants.",
    candidates: [
      { label: "Moscow", ianaTimeZone: "Europe/Moscow" },
      { label: "Yekaterinburg", ianaTimeZone: "Asia/Yekaterinburg" },
      { label: "Novosibirsk", ianaTimeZone: "Asia/Novosibirsk" },
      { label: "Vladivostok", ianaTimeZone: "Asia/Vladivostok" },
    ],
  },
  brazil: {
    message:
      "Brazil spans multiple time zones. Ask which city or region the user wants.",
    candidates: [
      { label: "São Paulo / Brasília", ianaTimeZone: "America/Sao_Paulo" },
      { label: "Manaus", ianaTimeZone: "America/Manaus" },
    ],
  },
  mexico: {
    message:
      "Mexico spans multiple time zones. Ask which city or region the user wants.",
    candidates: [
      { label: "Mexico City (Central)", ianaTimeZone: "America/Mexico_City" },
      { label: "Cancún (Eastern)", ianaTimeZone: "America/Cancun" },
      { label: "Tijuana (Pacific)", ianaTimeZone: "America/Tijuana" },
    ],
  },
  indonesia: {
    message:
      "Indonesia spans three time zones. Ask which city or island the user wants.",
    candidates: [
      { label: "Jakarta (Western)", ianaTimeZone: "Asia/Jakarta" },
      { label: "Bali / Makassar (Central)", ianaTimeZone: "Asia/Makassar" },
      { label: "Jayapura (Eastern)", ianaTimeZone: "Asia/Jayapura" },
    ],
  },
  georgia: {
    message:
      "Georgia could mean the country or the US state. Ask which one the user means.",
    candidates: [
      { label: "Georgia (Country, Tbilisi)", ianaTimeZone: "Asia/Tbilisi" },
      { label: "Georgia (US State, Atlanta)", ianaTimeZone: "America/New_York" },
    ],
  },
  washington: {
    message:
      "Washington could mean Washington, D.C. or Washington State. Ask which one the user means.",
    candidates: [
      { label: "Washington, D.C.", ianaTimeZone: "America/New_York" },
      { label: "Washington State (Seattle)", ianaTimeZone: "America/Los_Angeles" },
    ],
  },
  springfield: {
    message:
      "There are multiple cities named Springfield in different time zones. Ask which state the user means.",
    candidates: [
      { label: "Springfield, Illinois", ianaTimeZone: "America/Chicago" },
      { label: "Springfield, Massachusetts", ianaTimeZone: "America/New_York" },
      { label: "Springfield, Oregon", ianaTimeZone: "America/Los_Angeles" },
    ],
  },
  cambridge: {
    message:
      "Cambridge could mean Cambridge in the UK or Cambridge, Massachusetts. Ask which one the user means.",
    candidates: [
      { label: "Cambridge, United Kingdom", ianaTimeZone: "Europe/London" },
      { label: "Cambridge, Massachusetts", ianaTimeZone: "America/New_York" },
    ],
  },
  portland: {
    message:
      "Portland could mean Portland, Oregon or Portland, Maine. Ask which one the user means.",
    candidates: [
      { label: "Portland, Oregon", ianaTimeZone: "America/Los_Angeles" },
      { label: "Portland, Maine", ianaTimeZone: "America/New_York" },
    ],
  },
  birmingham: {
    message:
      "Birmingham could mean Birmingham in the UK or Birmingham, Alabama. Ask which one the user means.",
    candidates: [
      { label: "Birmingham, United Kingdom", ianaTimeZone: "Europe/London" },
      { label: "Birmingham, Alabama", ianaTimeZone: "America/Chicago" },
    ],
  },
  victoria: {
    message:
      "Victoria could refer to multiple places in different time zones. Ask which location the user means.",
    candidates: [
      { label: "Victoria, Canada (BC)", ianaTimeZone: "America/Vancouver" },
      { label: "Victoria, Australia (Melbourne)", ianaTimeZone: "Australia/Sydney" },
      { label: "Victoria, Seychelles", ianaTimeZone: "Indian/Mahe" },
    ],
  },
  "san jose": {
    message:
      "San Jose could mean San Jose, California or San José, Costa Rica. Ask which one the user means.",
    candidates: [
      { label: "San Jose, California", ianaTimeZone: "America/Los_Angeles" },
      { label: "San José, Costa Rica", ianaTimeZone: "America/Costa_Rica" },
    ],
  },
  alexandria: {
    message:
      "Alexandria could mean Alexandria, Egypt or Alexandria, Virginia. Ask which one the user means.",
    candidates: [
      { label: "Alexandria, Egypt", ianaTimeZone: "Africa/Cairo" },
      { label: "Alexandria, Virginia", ianaTimeZone: "America/New_York" },
    ],
  },
  kingston: {
    message:
      "Kingston could mean Kingston, Jamaica or Kingston, Ontario. Ask which one the user means.",
    candidates: [
      { label: "Kingston, Jamaica", ianaTimeZone: "America/Jamaica" },
      { label: "Kingston, Ontario", ianaTimeZone: "America/Toronto" },
    ],
  },
};

const ALIAS_MAP: Record<string, TimeZoneCandidate> = {
  // India
  india: { label: "India", ianaTimeZone: "Asia/Kolkata" },
  bharat: { label: "India", ianaTimeZone: "Asia/Kolkata" },
  ist: { label: "India (IST)", ianaTimeZone: "Asia/Kolkata" },
  delhi: { label: "New Delhi, India", ianaTimeZone: "Asia/Kolkata" },
  "new delhi": { label: "New Delhi, India", ianaTimeZone: "Asia/Kolkata" },
  mumbai: { label: "Mumbai, India", ianaTimeZone: "Asia/Kolkata" },
  bombay: { label: "Mumbai, India", ianaTimeZone: "Asia/Kolkata" },
  bengaluru: { label: "Bengaluru, India", ianaTimeZone: "Asia/Kolkata" },
  bangalore: { label: "Bengaluru, India", ianaTimeZone: "Asia/Kolkata" },
  chennai: { label: "Chennai, India", ianaTimeZone: "Asia/Kolkata" },
  hyderabad: { label: "Hyderabad, India", ianaTimeZone: "Asia/Kolkata" },
  kolkata: { label: "Kolkata, India", ianaTimeZone: "Asia/Kolkata" },
  calcutta: { label: "Kolkata, India", ianaTimeZone: "Asia/Kolkata" },
  pune: { label: "Pune, India", ianaTimeZone: "Asia/Kolkata" },
  ahmedabad: { label: "Ahmedabad, India", ianaTimeZone: "Asia/Kolkata" },
  jaipur: { label: "Jaipur, India", ianaTimeZone: "Asia/Kolkata" },
  guwahati: { label: "Guwahati, India", ianaTimeZone: "Asia/Kolkata" },

  // Japan
  japan: { label: "Japan", ianaTimeZone: "Asia/Tokyo" },
  jst: { label: "Japan (JST)", ianaTimeZone: "Asia/Tokyo" },
  tokyo: { label: "Tokyo, Japan", ianaTimeZone: "Asia/Tokyo" },
  osaka: { label: "Osaka, Japan", ianaTimeZone: "Asia/Tokyo" },
  kyoto: { label: "Kyoto, Japan", ianaTimeZone: "Asia/Tokyo" },
  yokohama: { label: "Yokohama, Japan", ianaTimeZone: "Asia/Tokyo" },
  sapporo: { label: "Sapporo, Japan", ianaTimeZone: "Asia/Tokyo" },
  fukuoka: { label: "Fukuoka, Japan", ianaTimeZone: "Asia/Tokyo" },

  // UK & Ireland
  uk: { label: "United Kingdom", ianaTimeZone: "Europe/London" },
  "united kingdom": { label: "United Kingdom", ianaTimeZone: "Europe/London" },
  britain: { label: "United Kingdom", ianaTimeZone: "Europe/London" },
  "great britain": { label: "United Kingdom", ianaTimeZone: "Europe/London" },
  england: { label: "England, United Kingdom", ianaTimeZone: "Europe/London" },
  scotland: { label: "Scotland, United Kingdom", ianaTimeZone: "Europe/London" },
  wales: { label: "Wales, United Kingdom", ianaTimeZone: "Europe/London" },
  london: { label: "London, United Kingdom", ianaTimeZone: "Europe/London" },
  "london uk": { label: "London, United Kingdom", ianaTimeZone: "Europe/London" },
  "london, uk": { label: "London, United Kingdom", ianaTimeZone: "Europe/London" },
  "london, ontario": { label: "London, Ontario", ianaTimeZone: "America/Toronto" },
  manchester: { label: "Manchester, United Kingdom", ianaTimeZone: "Europe/London" },
  edinburgh: { label: "Edinburgh, United Kingdom", ianaTimeZone: "Europe/London" },
  bst: { label: "London (UK Time)", ianaTimeZone: "Europe/London" },
  ireland: { label: "Ireland", ianaTimeZone: "Europe/Dublin" },
  dublin: { label: "Dublin, Ireland", ianaTimeZone: "Europe/Dublin" },

  // US & Canada specific cities/zones
  "new york": { label: "New York, USA", ianaTimeZone: "America/New_York" },
  "new york city": { label: "New York, USA", ianaTimeZone: "America/New_York" },
  nyc: { label: "New York, USA", ianaTimeZone: "America/New_York" },
  manhattan: { label: "New York, USA", ianaTimeZone: "America/New_York" },
  boston: { label: "Boston, USA", ianaTimeZone: "America/New_York" },
  miami: { label: "Miami, USA", ianaTimeZone: "America/New_York" },
  atlanta: { label: "Atlanta, USA", ianaTimeZone: "America/New_York" },
  philadelphia: { label: "Philadelphia, USA", ianaTimeZone: "America/New_York" },
  "washington dc": { label: "Washington, D.C., USA", ianaTimeZone: "America/New_York" },
  "washington, dc": { label: "Washington, D.C., USA", ianaTimeZone: "America/New_York" },
  "washington d.c.": { label: "Washington, D.C., USA", ianaTimeZone: "America/New_York" },
  "eastern time": { label: "US Eastern Time", ianaTimeZone: "America/New_York" },
  est: { label: "US Eastern Time", ianaTimeZone: "America/New_York" },
  edt: { label: "US Eastern Time", ianaTimeZone: "America/New_York" },

  chicago: { label: "Chicago, USA", ianaTimeZone: "America/Chicago" },
  dallas: { label: "Dallas, USA", ianaTimeZone: "America/Chicago" },
  houston: { label: "Houston, USA", ianaTimeZone: "America/Chicago" },
  austin: { label: "Austin, USA", ianaTimeZone: "America/Chicago" },
  "central time": { label: "US Central Time", ianaTimeZone: "America/Chicago" },
  cst: { label: "US Central Time", ianaTimeZone: "America/Chicago" },
  cdt: { label: "US Central Time", ianaTimeZone: "America/Chicago" },

  denver: { label: "Denver, USA", ianaTimeZone: "America/Denver" },
  "salt lake city": { label: "Salt Lake City, USA", ianaTimeZone: "America/Denver" },
  "mountain time": { label: "US Mountain Time", ianaTimeZone: "America/Denver" },
  mst: { label: "US Mountain Time", ianaTimeZone: "America/Denver" },
  mdt: { label: "US Mountain Time", ianaTimeZone: "America/Denver" },
  phoenix: { label: "Phoenix, Arizona", ianaTimeZone: "America/Phoenix" },
  arizona: { label: "Arizona, USA", ianaTimeZone: "America/Phoenix" },

  "los angeles": { label: "Los Angeles, USA", ianaTimeZone: "America/Los_Angeles" },
  la: { label: "Los Angeles, USA", ianaTimeZone: "America/Los_Angeles" },
  "san francisco": { label: "San Francisco, USA", ianaTimeZone: "America/Los_Angeles" },
  sf: { label: "San Francisco, USA", ianaTimeZone: "America/Los_Angeles" },
  california: { label: "California, USA", ianaTimeZone: "America/Los_Angeles" },
  seattle: { label: "Seattle, USA", ianaTimeZone: "America/Los_Angeles" },
  "las vegas": { label: "Las Vegas, USA", ianaTimeZone: "America/Los_Angeles" },
  "san diego": { label: "San Diego, USA", ianaTimeZone: "America/Los_Angeles" },
  "pacific time": { label: "US Pacific Time", ianaTimeZone: "America/Los_Angeles" },
  pst: { label: "US Pacific Time", ianaTimeZone: "America/Los_Angeles" },
  pdt: { label: "US Pacific Time", ianaTimeZone: "America/Los_Angeles" },
  alaska: { label: "Alaska, USA", ianaTimeZone: "America/Anchorage" },
  anchorage: { label: "Anchorage, Alaska", ianaTimeZone: "America/Anchorage" },
  hawaii: { label: "Hawaii, USA", ianaTimeZone: "Pacific/Honolulu" },
  honolulu: { label: "Honolulu, Hawaii", ianaTimeZone: "Pacific/Honolulu" },

  toronto: { label: "Toronto, Canada", ianaTimeZone: "America/Toronto" },
  montreal: { label: "Montreal, Canada", ianaTimeZone: "America/Toronto" },
  ottawa: { label: "Ottawa, Canada", ianaTimeZone: "America/Toronto" },
  vancouver: { label: "Vancouver, Canada", ianaTimeZone: "America/Vancouver" },
  calgary: { label: "Calgary, Canada", ianaTimeZone: "America/Edmonton" },
  edmonton: { label: "Edmonton, Canada", ianaTimeZone: "America/Edmonton" },
  winnipeg: { label: "Winnipeg, Canada", ianaTimeZone: "America/Winnipeg" },
  halifax: { label: "Halifax, Canada", ianaTimeZone: "America/Halifax" },

  // Europe
  france: { label: "France", ianaTimeZone: "Europe/Paris" },
  paris: { label: "Paris, France", ianaTimeZone: "Europe/Paris" },
  germany: { label: "Germany", ianaTimeZone: "Europe/Berlin" },
  berlin: { label: "Berlin, Germany", ianaTimeZone: "Europe/Berlin" },
  munich: { label: "Munich, Germany", ianaTimeZone: "Europe/Berlin" },
  frankfurt: { label: "Frankfurt, Germany", ianaTimeZone: "Europe/Berlin" },
  italy: { label: "Italy", ianaTimeZone: "Europe/Rome" },
  rome: { label: "Rome, Italy", ianaTimeZone: "Europe/Rome" },
  milan: { label: "Milan, Italy", ianaTimeZone: "Europe/Rome" },
  spain: { label: "Spain", ianaTimeZone: "Europe/Madrid" },
  madrid: { label: "Madrid, Spain", ianaTimeZone: "Europe/Madrid" },
  barcelona: { label: "Barcelona, Spain", ianaTimeZone: "Europe/Madrid" },
  portugal: { label: "Portugal", ianaTimeZone: "Europe/Lisbon" },
  lisbon: { label: "Lisbon, Portugal", ianaTimeZone: "Europe/Lisbon" },
  netherlands: { label: "Netherlands", ianaTimeZone: "Europe/Amsterdam" },
  amsterdam: { label: "Amsterdam, Netherlands", ianaTimeZone: "Europe/Amsterdam" },
  belgium: { label: "Belgium", ianaTimeZone: "Europe/Brussels" },
  brussels: { label: "Brussels, Belgium", ianaTimeZone: "Europe/Brussels" },
  switzerland: { label: "Switzerland", ianaTimeZone: "Europe/Zurich" },
  zurich: { label: "Zurich, Switzerland", ianaTimeZone: "Europe/Zurich" },
  geneva: { label: "Geneva, Switzerland", ianaTimeZone: "Europe/Zurich" },
  austria: { label: "Austria", ianaTimeZone: "Europe/Vienna" },
  vienna: { label: "Vienna, Austria", ianaTimeZone: "Europe/Vienna" },
  sweden: { label: "Sweden", ianaTimeZone: "Europe/Stockholm" },
  stockholm: { label: "Stockholm, Sweden", ianaTimeZone: "Europe/Stockholm" },
  norway: { label: "Norway", ianaTimeZone: "Europe/Oslo" },
  oslo: { label: "Oslo, Norway", ianaTimeZone: "Europe/Oslo" },
  denmark: { label: "Denmark", ianaTimeZone: "Europe/Copenhagen" },
  copenhagen: { label: "Copenhagen, Denmark", ianaTimeZone: "Europe/Copenhagen" },
  finland: { label: "Finland", ianaTimeZone: "Europe/Helsinki" },
  helsinki: { label: "Helsinki, Finland", ianaTimeZone: "Europe/Helsinki" },
  poland: { label: "Poland", ianaTimeZone: "Europe/Warsaw" },
  warsaw: { label: "Warsaw, Poland", ianaTimeZone: "Europe/Warsaw" },
  greece: { label: "Greece", ianaTimeZone: "Europe/Athens" },
  athens: { label: "Athens, Greece", ianaTimeZone: "Europe/Athens" },
  turkey: { label: "Turkey", ianaTimeZone: "Europe/Istanbul" },
  istanbul: { label: "Istanbul, Turkey", ianaTimeZone: "Europe/Istanbul" },
  ankara: { label: "Ankara, Turkey", ianaTimeZone: "Europe/Istanbul" },
  ukraine: { label: "Ukraine", ianaTimeZone: "Europe/Kyiv" },
  kyiv: { label: "Kyiv, Ukraine", ianaTimeZone: "Europe/Kyiv" },
  moscow: { label: "Moscow, Russia", ianaTimeZone: "Europe/Moscow" },
  cet: { label: "Central European Time", ianaTimeZone: "Europe/Paris" },
  cest: { label: "Central European Time", ianaTimeZone: "Europe/Paris" },

  // Middle East & Africa
  uae: { label: "United Arab Emirates", ianaTimeZone: "Asia/Dubai" },
  "united arab emirates": { label: "United Arab Emirates", ianaTimeZone: "Asia/Dubai" },
  dubai: { label: "Dubai, UAE", ianaTimeZone: "Asia/Dubai" },
  "abu dhabi": { label: "Abu Dhabi, UAE", ianaTimeZone: "Asia/Dubai" },
  "saudi arabia": { label: "Saudi Arabia", ianaTimeZone: "Asia/Riyadh" },
  riyadh: { label: "Riyadh, Saudi Arabia", ianaTimeZone: "Asia/Riyadh" },
  qatar: { label: "Qatar", ianaTimeZone: "Asia/Qatar" },
  doha: { label: "Doha, Qatar", ianaTimeZone: "Asia/Qatar" },
  israel: { label: "Israel", ianaTimeZone: "Asia/Jerusalem" },
  "tel aviv": { label: "Tel Aviv, Israel", ianaTimeZone: "Asia/Jerusalem" },
  jerusalem: { label: "Jerusalem, Israel", ianaTimeZone: "Asia/Jerusalem" },
  egypt: { label: "Egypt", ianaTimeZone: "Africa/Cairo" },
  cairo: { label: "Cairo, Egypt", ianaTimeZone: "Africa/Cairo" },
  "south africa": { label: "South Africa", ianaTimeZone: "Africa/Johannesburg" },
  johannesburg: { label: "Johannesburg, South Africa", ianaTimeZone: "Africa/Johannesburg" },
  "cape town": { label: "Cape Town, South Africa", ianaTimeZone: "Africa/Johannesburg" },
  nigeria: { label: "Nigeria", ianaTimeZone: "Africa/Lagos" },
  lagos: { label: "Lagos, Nigeria", ianaTimeZone: "Africa/Lagos" },
  kenya: { label: "Kenya", ianaTimeZone: "Africa/Nairobi" },
  nairobi: { label: "Nairobi, Kenya", ianaTimeZone: "Africa/Nairobi" },
  morocco: { label: "Morocco", ianaTimeZone: "Africa/Casablanca" },
  casablanca: { label: "Casablanca, Morocco", ianaTimeZone: "Africa/Casablanca" },

  // Asia-Pacific
  china: { label: "China", ianaTimeZone: "Asia/Shanghai" },
  beijing: { label: "Beijing, China", ianaTimeZone: "Asia/Shanghai" },
  shanghai: { label: "Shanghai, China", ianaTimeZone: "Asia/Shanghai" },
  shenzhen: { label: "Shenzhen, China", ianaTimeZone: "Asia/Shanghai" },
  "hong kong": { label: "Hong Kong", ianaTimeZone: "Asia/Hong_Kong" },
  taiwan: { label: "Taiwan", ianaTimeZone: "Asia/Taipei" },
  taipei: { label: "Taipei, Taiwan", ianaTimeZone: "Asia/Taipei" },
  "south korea": { label: "South Korea", ianaTimeZone: "Asia/Seoul" },
  korea: { label: "South Korea", ianaTimeZone: "Asia/Seoul" },
  seoul: { label: "Seoul, South Korea", ianaTimeZone: "Asia/Seoul" },
  singapore: { label: "Singapore", ianaTimeZone: "Asia/Singapore" },
  malaysia: { label: "Malaysia", ianaTimeZone: "Asia/Kuala_Lumpur" },
  "kuala lumpur": { label: "Kuala Lumpur, Malaysia", ianaTimeZone: "Asia/Kuala_Lumpur" },
  thailand: { label: "Thailand", ianaTimeZone: "Asia/Bangkok" },
  bangkok: { label: "Bangkok, Thailand", ianaTimeZone: "Asia/Bangkok" },
  vietnam: { label: "Vietnam", ianaTimeZone: "Asia/Ho_Chi_Minh" },
  hanoi: { label: "Hanoi, Vietnam", ianaTimeZone: "Asia/Ho_Chi_Minh" },
  "ho chi minh city": { label: "Ho Chi Minh City, Vietnam", ianaTimeZone: "Asia/Ho_Chi_Minh" },
  philippines: { label: "Philippines", ianaTimeZone: "Asia/Manila" },
  manila: { label: "Manila, Philippines", ianaTimeZone: "Asia/Manila" },
  jakarta: { label: "Jakarta, Indonesia", ianaTimeZone: "Asia/Jakarta" },
  bali: { label: "Bali, Indonesia", ianaTimeZone: "Asia/Makassar" },
  pakistan: { label: "Pakistan", ianaTimeZone: "Asia/Karachi" },
  karachi: { label: "Karachi, Pakistan", ianaTimeZone: "Asia/Karachi" },
  lahore: { label: "Lahore, Pakistan", ianaTimeZone: "Asia/Karachi" },
  islamabad: { label: "Islamabad, Pakistan", ianaTimeZone: "Asia/Karachi" },
  bangladesh: { label: "Bangladesh", ianaTimeZone: "Asia/Dhaka" },
  dhaka: { label: "Dhaka, Bangladesh", ianaTimeZone: "Asia/Dhaka" },
  nepal: { label: "Nepal", ianaTimeZone: "Asia/Kathmandu" },
  kathmandu: { label: "Kathmandu, Nepal", ianaTimeZone: "Asia/Kathmandu" },
  "sri lanka": { label: "Sri Lanka", ianaTimeZone: "Asia/Colombo" },
  colombo: { label: "Colombo, Sri Lanka", ianaTimeZone: "Asia/Colombo" },

  // Oceania
  sydney: { label: "Sydney, Australia", ianaTimeZone: "Australia/Sydney" },
  melbourne: { label: "Melbourne, Australia", ianaTimeZone: "Australia/Melbourne" },
  brisbane: { label: "Brisbane, Australia", ianaTimeZone: "Australia/Brisbane" },
  perth: { label: "Perth, Australia", ianaTimeZone: "Australia/Perth" },
  adelaide: { label: "Adelaide, Australia", ianaTimeZone: "Australia/Adelaide" },
  "new zealand": { label: "New Zealand", ianaTimeZone: "Pacific/Auckland" },
  auckland: { label: "Auckland, New Zealand", ianaTimeZone: "Pacific/Auckland" },
  wellington: { label: "Wellington, New Zealand", ianaTimeZone: "Pacific/Auckland" },

  // Latin America & UTC
  argentina: { label: "Argentina", ianaTimeZone: "America/Argentina/Buenos_Aires" },
  "buenos aires": { label: "Buenos Aires, Argentina", ianaTimeZone: "America/Argentina/Buenos_Aires" },
  "sao paulo": { label: "São Paulo, Brazil", ianaTimeZone: "America/Sao_Paulo" },
  "são paulo": { label: "São Paulo, Brazil", ianaTimeZone: "America/Sao_Paulo" },
  "rio de janeiro": { label: "Rio de Janeiro, Brazil", ianaTimeZone: "America/Sao_Paulo" },
  "mexico city": { label: "Mexico City, Mexico", ianaTimeZone: "America/Mexico_City" },
  colombia: { label: "Colombia", ianaTimeZone: "America/Bogota" },
  bogota: { label: "Bogotá, Colombia", ianaTimeZone: "America/Bogota" },
  peru: { label: "Peru", ianaTimeZone: "America/Lima" },
  lima: { label: "Lima, Peru", ianaTimeZone: "America/Lima" },
  chile: { label: "Chile", ianaTimeZone: "America/Santiago" },
  santiago: { label: "Santiago, Chile", ianaTimeZone: "America/Santiago" },
  utc: { label: "Coordinated Universal Time (UTC)", ianaTimeZone: "UTC" },
  gmt: { label: "Greenwich Mean Time (GMT)", ianaTimeZone: "UTC" },
};

const IANA_CITY_INDEX: Map<string, TimeZoneCandidate[]> = (() => {
  const index = new Map<string, TimeZoneCandidate[]>();
  try {
    for (const tz of Intl.supportedValuesOf("timeZone")) {
      const segments = tz.split("/");
      const cityRaw = segments[segments.length - 1] ?? "";
      const cityKey = cityRaw.replace(/_/g, " ").toLowerCase().trim();
      if (!cityKey) continue;
      const list = index.get(cityKey) ?? [];
      list.push({
        label: `${cityRaw.replace(/_/g, " ")} (${tz})`,
        ianaTimeZone: tz,
      });
      index.set(cityKey, list);
    }
  } catch {
    // Fallback gracefully if supportedValuesOf is unavailable
  }
  return index;
})();

export function isValidIanaTimeZone(timeZone: string): boolean {
  if (!timeZone || typeof timeZone !== "string") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

function normalizeQuery(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^(the|city of)\s+/i, "");
}

function getZonedDateParts(timeZone: string, date: Date) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(date);
  const map: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== "literal") {
      map[part.type] = part.value;
    }
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

export function getOffsetMinutes(timeZone: string, date: Date): number {
  const p = getZonedDateParts(timeZone, date);
  const zonedAsUtcMs = Date.UTC(
    p.year,
    p.month - 1,
    p.day,
    p.hour,
    p.minute,
    p.second
  );
  const actualUtcNoMs = Math.floor(date.getTime() / 1000) * 1000;
  return Math.round((zonedAsUtcMs - actualUtcNoMs) / 60000);
}

export function formatUtcOffset(offsetMinutes: number): string {
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const hours = Math.floor(abs / 60)
    .toString()
    .padStart(2, "0");
  const mins = (abs % 60).toString().padStart(2, "0");
  return `UTC${sign}${hours}:${mins}`;
}

export function getDstStatus(
  timeZone: string,
  date: Date
): { observesDst: boolean; dstActive: boolean } {
  const year = date.getUTCFullYear();
  const janOffset = getOffsetMinutes(
    timeZone,
    new Date(Date.UTC(year, 0, 1, 12, 0, 0))
  );
  const julOffset = getOffsetMinutes(
    timeZone,
    new Date(Date.UTC(year, 6, 1, 12, 0, 0))
  );
  if (janOffset === julOffset) {
    return { observesDst: false, dstActive: false };
  }
  const standardOffset = Math.min(janOffset, julOffset);
  const currentOffset = getOffsetMinutes(timeZone, date);
  return {
    observesDst: true,
    dstActive: currentOffset > standardOffset,
  };
}

function formatDuration(minutesAbs: number): string {
  if (minutesAbs === 0) return "0 minutes";
  const hours = Math.floor(minutesAbs / 60);
  const mins = minutesAbs % 60;
  const parts: string[] = [];
  if (hours > 0) {
    parts.push(`${hours} ${hours === 1 ? "hour" : "hours"}`);
  }
  if (mins > 0) {
    parts.push(`${mins} ${mins === 1 ? "minute" : "minutes"}`);
  }
  return parts.join(" and ");
}

function buildResolvedClock(
  query: string,
  resolvedLabel: string,
  ianaTimeZone: string,
  now: Date
): ResolvedWorldClock {
  const p = getZonedDateParts(ianaTimeZone, now);
  const isoDate = `${p.year}-${String(p.month).padStart(2, "0")}-${String(
    p.day
  ).padStart(2, "0")}`;

  const time12Hour = new Intl.DateTimeFormat("en-US", {
    timeZone: ianaTimeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(now);

  const time24Hour = `${String(p.hour).padStart(2, "0")}:${String(
    p.minute
  ).padStart(2, "0")}`;

  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: ianaTimeZone,
    weekday: "long",
  }).format(now);

  const dateFormatted = new Intl.DateTimeFormat("en-US", {
    timeZone: ianaTimeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(now);

  const zoneParts = new Intl.DateTimeFormat("en-US", {
    timeZone: ianaTimeZone,
    timeZoneName: "long",
  }).formatToParts(now);
  const timeZoneName =
    zoneParts.find((part) => part.type === "timeZoneName")?.value ||
    ianaTimeZone;

  const offsetMinutes = getOffsetMinutes(ianaTimeZone, now);
  const { observesDst, dstActive } = getDstStatus(ianaTimeZone, now);

  return {
    status: "resolved",
    query,
    resolvedLabel,
    ianaTimeZone,
    time12Hour,
    time24Hour,
    weekday,
    dateFormatted,
    isoDate,
    utcOffset: formatUtcOffset(offsetMinutes),
    offsetMinutes,
    observesDst,
    dstActive,
    timeZoneName,
  };
}

function resolveLocation(
  rawLocation: string | undefined,
  useLocal: boolean,
  userLocalTimeZone?: string
):
  | { status: "resolved"; label: string; ianaTimeZone: string }
  | AmbiguousWorldClock
  | NotFoundWorldClock {
  const query = (rawLocation ?? "").trim();

  if (
    useLocal ||
    /^(here|local|my\s+time|my\s+location|current\s+location)$/i.test(query)
  ) {
    if (userLocalTimeZone && isValidIanaTimeZone(userLocalTimeZone)) {
      return {
        status: "resolved",
        label: `your local time zone (${userLocalTimeZone.replace(/_/g, " ")})`,
        ianaTimeZone: userLocalTimeZone,
      };
    }
    return {
      status: "not_found",
      query: query || "local time",
      message:
        "Local device time zone was not detected. Ask the user which city or country they are in.",
    };
  }

  if (!query) {
    return {
      status: "not_found",
      query: "",
      message: "No location was specified. Ask which city or country to check.",
    };
  }

  // Exact IANA identifier passed directly (e.g., "America/New_York")
  if (query.includes("/") && isValidIanaTimeZone(query)) {
    return {
      status: "resolved",
      label: query.split("/").pop()?.replace(/_/g, " ") || query,
      ianaTimeZone: query,
    };
  }

  const normalized = normalizeQuery(query);

  const ambiguous = AMBIGUOUS_LOCATIONS[normalized];
  if (ambiguous) {
    return {
      status: "ambiguous",
      query,
      message: ambiguous.message,
      candidates: ambiguous.candidates,
    };
  }

  const aliased = ALIAS_MAP[normalized];
  if (aliased && isValidIanaTimeZone(aliased.ianaTimeZone)) {
    return {
      status: "resolved",
      label: aliased.label,
      ianaTimeZone: aliased.ianaTimeZone,
    };
  }

  // Fallback to IANA city segment matching (e.g. "Reykjavik", "Auckland", "Nairobi")
  const ianaMatches = IANA_CITY_INDEX.get(normalized);
  if (ianaMatches && ianaMatches.length === 1) {
    return {
      status: "resolved",
      label: ianaMatches[0].label,
      ianaTimeZone: ianaMatches[0].ianaTimeZone,
    };
  }
  if (ianaMatches && ianaMatches.length > 1) {
    return {
      status: "ambiguous",
      query,
      message: `Multiple places match "${query}". Ask the user which one they mean.`,
      candidates: ianaMatches.slice(0, 4),
    };
  }

  return {
    status: "not_found",
    query,
    message: `Could not match "${query}" to a known IANA time zone. Ask the user for a nearby major city or country.`,
  };
}

export function getWorldClock(
  params: {
    location?: string;
    useUserLocalTime?: boolean;
  },
  userLocalTimeZone?: string,
  now: Date = new Date()
): WorldClockLookupResult {
  const resolution = resolveLocation(
    params.location,
    Boolean(params.useUserLocalTime),
    userLocalTimeZone
  );
  if (resolution.status !== "resolved") {
    return resolution;
  }
  return buildResolvedClock(
    params.location || "local",
    resolution.label,
    resolution.ianaTimeZone,
    now
  );
}

export function getTimeDifference(
  params: {
    locationA: string;
    locationB?: string;
    compareWithUserLocalTime?: boolean;
  },
  userLocalTimeZone?: string,
  now: Date = new Date()
): TimeDifferenceResult {
  const resA = resolveLocation(params.locationA, false, userLocalTimeZone);
  if (resA.status !== "resolved") {
    return {
      status: resA.status,
      locationQuery: params.locationA,
      message: resA.message,
      candidates: "candidates" in resA ? resA.candidates : undefined,
    };
  }

  const useLocalForB =
    Boolean(params.compareWithUserLocalTime) || !params.locationB?.trim();
  const resB = resolveLocation(
    params.locationB,
    useLocalForB,
    userLocalTimeZone
  );
  if (resB.status !== "resolved") {
    return {
      status: resB.status,
      locationQuery: params.locationB || "local time",
      message: resB.message,
      candidates: "candidates" in resB ? resB.candidates : undefined,
    };
  }

  const clockA = buildResolvedClock(
    params.locationA,
    resA.label,
    resA.ianaTimeZone,
    now
  );
  const clockB = buildResolvedClock(
    params.locationB || "local",
    resB.label,
    resB.ianaTimeZone,
    now
  );

  const differenceMinutes = clockA.offsetMinutes - clockB.offsetMinutes;
  const absoluteDifferenceMinutes = Math.abs(differenceMinutes);
  const differenceFormatted = formatDuration(absoluteDifferenceMinutes);

  const relation =
    differenceMinutes === 0
      ? `${clockA.resolvedLabel} and ${clockB.resolvedLabel} are in the same time offset`
      : differenceMinutes > 0
        ? `${clockA.resolvedLabel} is ${differenceFormatted} ahead of ${clockB.resolvedLabel}`
        : `${clockA.resolvedLabel} is ${differenceFormatted} behind ${clockB.resolvedLabel}`;

  let calendarDayDifference = "same calendar date";
  if (clockA.isoDate > clockB.isoDate) {
    calendarDayDifference = `${clockA.resolvedLabel} is on the next calendar day compared to ${clockB.resolvedLabel}`;
  } else if (clockA.isoDate < clockB.isoDate) {
    calendarDayDifference = `${clockA.resolvedLabel} is on the previous calendar day compared to ${clockB.resolvedLabel}`;
  }

  return {
    status: "resolved",
    locationA: clockA,
    locationB: clockB,
    differenceMinutes,
    absoluteDifferenceMinutes,
    differenceFormatted,
    relation,
    calendarDayDifference,
    summary: `${relation} (${calendarDayDifference}).`,
  };
}

export const WORLD_CLOCK_FUNCTION_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: "get_world_clock",
    description:
      "Gets the exact real-time current time, weekday, date, UTC offset, and Daylight Saving Time (DST) status for any country, city, or IANA time zone using the server clock. Always call this for any time, date, or DST question.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        location: {
          type: Type.STRING,
          description:
            "City, country, region, or IANA time zone (for example: 'India', 'Japan', 'New York', 'London', 'Paris', 'Springfield'). Omit when useUserLocalTime is true.",
        },
        useUserLocalTime: {
          type: Type.BOOLEAN,
          description:
            "Set to true when the user asks for their own current/local time (for example: 'what time is it here' or 'what is today's date').",
        },
      },
    },
  },
  {
    name: "get_time_difference",
    description:
      "Calculates the exact current time difference (accounting for half-hour offsets, DST, and calendar date difference) between two cities, countries, or time zones. Always call this for any time-difference question.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        locationA: {
          type: Type.STRING,
          description: "First city, country, or IANA time zone.",
        },
        locationB: {
          type: Type.STRING,
          description:
            "Second city, country, or IANA time zone. Omit when compareWithUserLocalTime is true.",
        },
        compareWithUserLocalTime: {
          type: Type.BOOLEAN,
          description:
            "Set to true when comparing locationA against the user's own local time zone.",
        },
      },
      required: ["locationA"],
    },
  },
];

export function executeWorldClockTool(
  name: string | undefined,
  args: Record<string, unknown> | undefined,
  userLocalTimeZone?: string
): Record<string, unknown> {
  if (name === "get_world_clock") {
    const location =
      typeof args?.location === "string" ? args.location : undefined;
    const useUserLocalTime = Boolean(args?.useUserLocalTime);
    return getWorldClock(
      { location, useUserLocalTime },
      userLocalTimeZone
    ) as unknown as Record<string, unknown>;
  }

  if (name === "get_time_difference") {
    const locationA = typeof args?.locationA === "string" ? args.locationA : "";
    const locationB =
      typeof args?.locationB === "string" ? args.locationB : undefined;
    const compareWithUserLocalTime = Boolean(args?.compareWithUserLocalTime);
    return getTimeDifference(
      { locationA, locationB, compareWithUserLocalTime },
      userLocalTimeZone
    ) as unknown as Record<string, unknown>;
  }

  return {
    status: "error",
    message: `Unsupported tool "${name || "unknown"}".`,
  };
}
