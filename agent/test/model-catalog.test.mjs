import test from 'node:test';
import assert from 'node:assert/strict';
import { getBuiltinModel } from '@earendil-works/pi-ai/providers/all';
import { ModelRuntime, resolveCliModel } from '@earendil-works/pi-coding-agent';

test('GPT-6.2 Sol and Astra are in the OpenAI catalogs Poki Agent uses', () => {
  for (const provider of ['openai', 'openai-codex']) {
    for (const id of ['gpt-6.2-sol', 'gpt-6.2-astra']) {
      const model = getBuiltinModel(provider, id);
      assert.ok(model, `${provider} ${id}`);
      assert.equal(model.api, provider === 'openai' ? 'openai-responses' : 'openai-codex-responses');
      assert.equal(model.reasoning, true);
      assert.deepEqual(model.input, ['text', 'image']);
      assert.equal(model.maxTokens, 128_000);
    }
  }

  const sol = getBuiltinModel('openai', 'gpt-6.2-sol');
  assert.equal(sol.cost.input, 2);
  assert.equal(sol.cost.output, 10);
  const astra = getBuiltinModel('openai', 'gpt-6.2-astra');
  assert.equal(astra.cost.input, 8);
  assert.equal(astra.cost.output, 40);
});

test('GPT-6.2 Sol and Astra resolve through the same pi path Poki Agent uses', async () => {
  const runtime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
  for (const provider of ['openai', 'openai-codex']) {
    for (const id of ['gpt-6.2-sol', 'gpt-6.2-astra']) {
      const resolved = resolveCliModel({ cliProvider: provider, cliModel: id, modelRuntime: runtime });
      assert.equal(resolved.error, undefined);
      assert.equal(resolved.model?.id, id);
      assert.equal(resolved.model?.provider, provider);
    }
  }
});
