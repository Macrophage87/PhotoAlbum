/**
 * Places a name may also be: US states, countries, capitals and large or well-known cities, lower case and without
 * accents. Only a name on this list is ever taken for a place because of the words around it ("a train to Florence",
 * "Georgia, USA"); anybody else after "to", "at" or "from" is a person ("waving to Ximena"). Small and hand-picked on
 * purpose: it only has to hold the places that are also somebody's name, and a place missing from it errs towards
 * taking a name out.
 */
export const PLACE_NAMES = new Set([
  // US states
  "alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut", "delaware", "florida", "georgia", "hawaii", "idaho",
  "illinois", "indiana", "iowa", "kansas", "kentucky", "louisiana", "maine", "maryland", "massachusetts", "michigan", "minnesota", "mississippi",
  "missouri", "montana", "nebraska", "nevada", "new hampshire", "new jersey", "new mexico", "new york", "north carolina", "north dakota", "ohio",
  "oklahoma", "oregon", "pennsylvania", "rhode island", "south carolina", "south dakota", "tennessee", "texas", "utah", "vermont", "virginia",
  "washington", "west virginia", "wisconsin", "wyoming", "carolina", "dakota",
  // Countries and regions
  "afghanistan", "albania", "algeria", "andorra", "angola", "argentina", "armenia", "australia", "austria", "azerbaijan", "bahamas", "bahrain",
  "bangladesh", "barbados", "belarus", "belgium", "belize", "benin", "bermuda", "bhutan", "bolivia", "bosnia", "botswana", "brazil", "brunei",
  "bulgaria", "burundi", "cambodia", "cameroon", "canada", "chad", "chile", "china", "colombia", "congo", "croatia", "cuba", "cyprus", "czechia",
  "denmark", "djibouti", "dominica", "ecuador", "egypt", "england", "eritrea", "estonia", "ethiopia", "fiji", "finland", "france", "gabon",
  "gambia", "germany", "ghana", "greece", "grenada", "guatemala", "guinea", "guyana", "haiti", "honduras", "hungary", "iceland", "india",
  "indonesia", "iran", "iraq", "ireland", "israel", "italy", "jamaica", "japan", "jordan", "kenya", "korea", "kosovo", "kuwait", "laos", "latvia",
  "lebanon", "lesotho", "liberia", "libya", "lithuania", "luxembourg", "madagascar", "malawi", "malaysia", "maldives", "mali", "malta", "mexico",
  "moldova", "monaco", "mongolia", "montenegro", "morocco", "mozambique", "myanmar", "namibia", "nepal", "netherlands", "holland", "nicaragua",
  "niger", "nigeria", "norway", "oman", "pakistan", "panama", "paraguay", "peru", "philippines", "poland", "portugal", "qatar", "romania", "russia",
  "rwanda", "samoa", "scotland", "senegal", "serbia", "seychelles", "singapore", "slovakia", "slovenia", "somalia", "spain", "sudan", "suriname",
  "sweden", "switzerland", "syria", "taiwan", "tanzania", "thailand", "togo", "tonga", "tunisia", "turkey", "uganda", "ukraine", "uruguay",
  "uzbekistan", "vanuatu", "venezuela", "vietnam", "wales", "yemen", "zambia", "zimbabwe", "america", "europe", "asia", "africa", "antarctica",
  "tuscany", "provence", "bavaria", "normandy", "brittany", "cornwall", "devon", "kent", "sussex", "essex", "yorkshire", "patagonia", "siberia",
  "tasmania", "queensland", "ontario", "quebec", "alberta", "manitoba", "victoria", "catalonia", "andalusia", "sicily", "sardinia", "corsica",
  // Capitals and cities
  "abu dhabi", "accra", "adelaide", "alexandria", "algiers", "amman", "amsterdam", "ankara", "athens", "atlanta", "auckland", "austin", "baghdad",
  "baltimore", "bangkok", "barcelona", "beijing", "beirut", "belfast", "belgrade", "berlin", "bern", "bogota", "bologna", "bombay", "bordeaux",
  "boston", "brisbane", "bristol", "brooklyn", "brussels", "bucharest", "budapest", "buenos aires", "cairo", "calgary", "cambridge", "canberra",
  "cape town", "caracas", "cardiff", "charleston", "charlotte", "chelsea", "chicago", "cincinnati", "cleveland", "cologne", "copenhagen", "cork",
  "dallas", "damascus", "delhi", "denver", "detroit", "doha", "dresden", "dubai", "dublin", "durham", "edinburgh", "florence", "frankfurt",
  "geneva", "genoa", "glasgow", "granada", "hamburg", "hanoi", "havana", "helsinki", "hollywood", "houston", "istanbul", "jackson", "jakarta",
  "jerusalem", "johannesburg", "kabul", "kathmandu", "kiev", "kyiv", "kingston", "kyoto", "lagos", "las vegas", "leeds", "lima", "lisbon",
  "liverpool", "london", "los angeles", "lyon", "madison", "madrid", "manchester", "manila", "marseille", "melbourne", "memphis", "miami",
  "milan", "montreal", "moscow", "mumbai", "munich", "nairobi", "naples", "nashville", "nice", "orlando", "osaka", "oslo", "ottawa", "oxford",
  "palermo", "paris", "perth", "philadelphia", "phoenix", "pisa", "portland", "prague", "quito", "raleigh", "reykjavik", "richmond", "riga",
  "rio", "riyadh", "rome", "rotterdam", "salzburg", "san diego", "san francisco", "santiago", "savannah", "seattle", "seoul", "seville",
  "shanghai", "siena", "sofia", "stockholm", "sydney", "tallinn", "tehran", "tokyo", "toronto", "tripoli", "tucson", "tunis", "turin",
  "valencia", "vancouver", "venice", "verona", "vienna", "vilnius", "warsaw", "wellington", "york", "zagreb", "zurich", "aspen", "boulder",
  "sedona", "tahoe", "napa", "sonoma", "malibu", "lincoln", "augusta", "columbia", "regina", "salem", "orleans", "lourdes", "fatima", "assisi",
]);
