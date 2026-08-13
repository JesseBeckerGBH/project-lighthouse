import { Router } from 'express';
import { getConfig } from '../config';
import { err, ok } from '../errors';
import { store } from '../storage/store';

export const demoResetRouter = Router();

demoResetRouter.post('/', (_req, res) => {
  const config = getConfig();
  if (config.nodeEnv !== 'development' && config.nodeEnv !== 'test') {
    res.status(404).json(err('VALIDATION_ERROR', 'Demo reset is not available in this environment.'));
    return;
  }
  store.reset();
  res.json(ok({ reset: true }));
});
