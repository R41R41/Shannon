import axios from 'axios';

export type TravelMode = 'DRIVE' | 'WALK' | 'BICYCLE' | 'TRANSIT' | 'TWO_WHEELER';

async function requireMapsKey(): Promise<string> {
  const { config } = await import('../../config/env.js');
  if (!config.google.mapsApiKey) throw new Error('GOOGLE_MAPS_API_KEY is not configured');
  return config.google.mapsApiKey;
}

function safeGoogleApiError(operation: string, error: unknown): Error {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const responseMessage = (error.response?.data as { error?: { message?: string } } | undefined)
      ?.error?.message;
    const detail = responseMessage || error.message || 'Unknown Google Maps error';
    return new Error(`${operation} failed${status ? ` (${status})` : ''}: ${detail}`);
  }
  return new Error(`${operation} failed: ${error instanceof Error ? error.message : String(error)}`);
}

export async function searchPlaces(textQuery: string, maxResults = 8): Promise<unknown[]> {
  try {
    const response = await axios.post('https://places.googleapis.com/v1/places:searchText', {
      textQuery,
      languageCode: 'ja',
      regionCode: 'JP',
      pageSize: Math.min(20, Math.max(1, maxResults)),
    }, {
      headers: {
        'X-Goog-Api-Key': await requireMapsKey(),
        'X-Goog-FieldMask': [
          'places.id', 'places.displayName', 'places.formattedAddress', 'places.location',
          'places.googleMapsUri', 'places.websiteUri', 'places.rating',
          'places.userRatingCount', 'places.regularOpeningHours', 'places.priceLevel',
        ].join(','),
        'Content-Type': 'application/json',
      },
      timeout: 15_000,
    });
    return response.data?.places ?? [];
  } catch (error) {
    throw safeGoogleApiError('Places API', error);
  }
}

export async function computeRoute(input: {
  origin: string;
  destination: string;
  intermediates?: string[];
  travelMode: TravelMode;
}): Promise<Record<string, unknown>> {
  try {
    const response = await axios.post('https://routes.googleapis.com/directions/v2:computeRoutes', {
      origin: { address: input.origin },
      destination: { address: input.destination },
      intermediates: input.intermediates?.map((address) => ({ address })),
      travelMode: input.travelMode,
      languageCode: 'ja-JP',
      units: 'METRIC',
      computeAlternativeRoutes: false,
    }, {
      headers: {
        'X-Goog-Api-Key': await requireMapsKey(),
        'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline,routes.warnings,routes.description',
        'Content-Type': 'application/json',
      },
      timeout: 20_000,
    });
    const route = response.data?.routes?.[0];
    if (!route) throw new Error('No route found');
    return route as Record<string, unknown>;
  } catch (error) {
    throw safeGoogleApiError('Routes API', error);
  }
}

export async function renderStaticRouteMap(encodedPolyline: string): Promise<string> {
  try {
    const params = new URLSearchParams({
      size: '900x420',
      scale: '2',
      format: 'png',
      maptype: 'roadmap',
      key: await requireMapsKey(),
    });
    params.append('path', `weight:5|color:0x0877b1ff|enc:${encodedPolyline}`);
    const response = await axios.get(`https://maps.googleapis.com/maps/api/staticmap?${params.toString()}`, {
      responseType: 'arraybuffer',
      timeout: 20_000,
      maxContentLength: 8 * 1024 * 1024,
    });
    return `data:image/png;base64,${Buffer.from(response.data).toString('base64')}`;
  } catch (error) {
    throw safeGoogleApiError('Maps Static API', error);
  }
}
