#!/usr/bin/env node

const apiKey = process.env.TYPESAFE_API_KEY?.trim();
const endpoint = process.env.SHANNON_JEV_ENDPOINT?.trim() || 'https://api.typesafe.ai/v1/systemone';
const model = process.env.SHANNON_JEV_MODEL?.trim() || 'jev-latest';

if (!apiKey) throw new Error('TYPESAFE_API_KEY is required');

const authorization = `Bearer ${apiKey}`;
const modelsResponse = await fetch('https://api.typesafe.ai/v1/models', {
  headers: { authorization },
});
const modelsJson = await modelsResponse.json();
const modelRows = Array.isArray(modelsJson)
  ? modelsJson
  : modelsJson.models ?? modelsJson.data ?? [];
const modelNames = modelRows
  .map(value => typeof value === 'string' ? value : value?.name ?? value?.id)
  .filter(Boolean);

const probeResponse = await fetch(endpoint, {
  method: 'POST',
  headers: {
    authorization,
    'content-type': 'application/json',
  },
  body: JSON.stringify({
    model,
    state: { purpose: 'Minebot credential connectivity check' },
    questions: {
      credential_probe: {
        type: 'noul',
        instructions: 'Is this state explicitly a Minebot credential connectivity check?',
        criteria: {
          true: 'The purpose explicitly says it is a Minebot credential connectivity check.',
          false: 'The purpose is something else.',
        },
      },
    },
  }),
});
const probeJson = await probeResponse.json();
const result = {
  modelsStatus: modelsResponse.status,
  jevLatestAvailable: modelNames.includes('jev-latest'),
  jevPreviewAvailable: modelNames.includes('jev-preview'),
  configuredModelAvailable: modelNames.includes(model),
  systemOneStatus: probeResponse.status,
  answerPresent: Boolean(probeJson?.answers?.credential_probe),
};

process.stdout.write(`${JSON.stringify(result)}\n`);
if (!modelsResponse.ok || !result.configuredModelAvailable || !probeResponse.ok || !result.answerPresent) {
  process.exitCode = 1;
}
