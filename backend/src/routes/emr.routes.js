const router = require('express').Router();
const { z } = require('zod');
const { authorize } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const emr = require('../services/emr.service');
const { audit } = require('../services/audit.service');

const uuid = z.string().uuid();

const romItem = z.object({
  joint: z.enum(['cervical', 'thoracic', 'lumbar', 'shoulder', 'elbow', 'wrist', 'hip', 'knee', 'ankle']),
  movement: z.string().min(2).max(40),
  side: z.enum(['left', 'right', 'na']).default('na'),
  mode: z.enum(['active', 'passive']).default('active'),
  degrees: z.number().min(-90).max(360),
  normal_degrees: z.number().min(0).max(360).nullish(),
  pain_on_movement: z.boolean().optional(),
  end_feel: z.string().max(40).nullish(),
});

const assessmentBody = z.object({
  pain_score: z.number().int().min(0).max(10).nullish(),
  pain_location: z.string().max(200).nullish(),
  pain_character: z.string().max(100).nullish(),
  vitals: z.object({
    bp_sys: z.number().int().min(50).max(260).optional(),
    bp_dia: z.number().int().min(30).max(160).optional(),
    hr: z.number().int().min(20).max(250).optional(),
    spo2: z.number().int().min(50).max(100).optional(),
  }).nullish(),
  subjective: z.string().max(5000).nullish(),
  objective: z.string().max(5000).nullish(),
  assessment: z.string().max(5000).nullish(),
  plan: z.string().max(5000).nullish(),
  precautions_reviewed: z.boolean().optional(),
  red_flags: z.string().max(2000).nullish(),
  treatment_response: z.enum(['improved', 'unchanged', 'worsened']).nullish(),
  adverse_events: z.string().max(2000).nullish(),
  home_program: z.string().max(5000).nullish(),
  next_visit_plan: z.string().max(2000).nullish(),
  goals: z.array(z.object({ goal: z.string(), target: z.string().optional(), achieved_pct: z.number().min(0).max(100).optional() })).nullish(),
  functional_scores: z.record(z.string(), z.number()).nullish(),
  rom: z.array(romItem).max(40).optional(),
  treatments: z.array(z.object({
    equipment_id: uuid.nullish(),
    intervention: z.string().min(1).max(200),
    body_part: z.string().max(100).nullish(),
    parameters: z.record(z.string(), z.any()).nullish(),
    duration_min: z.number().int().min(1).max(240).nullish(),
  })).max(20).optional(),
  newPrecautions: z.array(z.object({ code: z.string(), detail: z.string().optional() })).optional(),
});

router.get('/appointments/:id', authorize('emr:read'), validate({ params: z.object({ id: uuid }) }), async (req, res) => {
  const data = await emr.getAppointmentAssessments(req.valid.params.id);
  await audit(req, 'emr.read', 'appointment', req.valid.params.id);
  res.json(data);
});

router.put('/appointments/:id/:phase', authorize('emr:write'), validate({
  params: z.object({ id: uuid, phase: z.enum(['pre', 'post']) }),
  body: assessmentBody,
}), async (req, res) => {
  const id = await emr.upsertAssessment(req.user, req.valid.params.id, req.valid.params.phase, req.valid.body);
  await audit(req, `emr.save_${req.valid.params.phase}`, 'assessment', id);
  res.json(await emr.getAppointmentAssessments(req.valid.params.id));
});

router.post('/assessments/:id/sign', authorize('emr:write'), validate({ params: z.object({ id: uuid }) }), async (req, res) => {
  const a = await emr.signAssessment(req.user, req.valid.params.id);
  await audit(req, 'emr.sign', 'assessment', a.id);
  res.json(a);
});

router.post('/assessments/:id/addenda', authorize('emr:write'), validate({
  params: z.object({ id: uuid }), body: z.object({ content: z.string().min(1).max(5000) }),
}), async (req, res) => {
  const a = await emr.addAddendum(req.user, req.valid.params.id, req.valid.body.content);
  await audit(req, 'emr.addendum', 'assessment', req.valid.params.id);
  res.status(201).json(a);
});

router.get('/patients/:id/progress', authorize('emr:read'), validate({ params: z.object({ id: uuid }) }), async (req, res) => {
  const data = await emr.patientProgress(req.valid.params.id);
  await audit(req, 'emr.progress_read', 'patient', req.valid.params.id);
  res.json(data);
});

module.exports = router;
