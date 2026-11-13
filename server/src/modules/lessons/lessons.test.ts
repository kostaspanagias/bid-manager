import { describe, expect, it } from 'vitest';
import { addMember, as, createOrg, createTender, createUser, dbFor, missingId } from '../../test/harness.js';

async function setup(tenderOverrides: Record<string, unknown> = {}) {
  const org = await createOrg();
  const admin = await createUser(org, 'admin');
  const manager = await createUser(org, 'bid_manager');
  const member = await createUser(org, 'member', { name: 'Μέλος Α' });
  const tender = await createTender(org, tenderOverrides);
  await addMember(tender, member, 'A');
  return { org, admin, manager, member, tender, base: `/api/tenders/${tender.id}/lessons` };
}

const template = (org: { id: string }, version: string, status = 'published', name = 'L') =>
  dbFor(org).insert('template', { name, version, status, published_at: status === 'published' ? new Date() : null });

describe('/api/tenders/:tenderId/lessons', () => {
  it('a member adds lessons with category and the template flag; the list shows author and state', async () => {
    const { org, member, base } = await setup();
    const api = await as(member);
    const res = await api.post(base).send({ text: '  Η εγγυητική ζητήθηκε αργά  ', category: 'delay', changes_template: true });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      text: 'Η εγγυητική ζητήθηκε αργά',
      category: 'delay',
      changes_template: true,
      applied_in_version: null,
      applied_template_id: null,
      created_by: member.id,
      created_by_name: 'Μέλος Α',
    });
    const plain = await api.post(base).send({ text: 'Καλή συνεργασία με τον εταίρο' });
    expect(plain.body).toMatchObject({ category: null, changes_template: false });
    const list = await api.get(base);
    expect(list.body.items.map((l: { id: string }) => l.id)).toEqual([res.body.id, plain.body.id]);
    expect(await dbFor(org).findOne('audit_log', { entity: 'lesson', entity_id: res.body.id, action: 'create' })).toMatchObject({ user_id: member.id });

    for (const body of [{}, { text: '   ' }, { text: 'x', category: 'gossip' }, { text: 'x', applied_in_version: '9.9' }, { text: 'x', tender_id: missingId() }]) {
      expect((await api.post(base).send(body)).status).toBe(400);
    }
  });

  it('lessons can be recorded on a closed tender', async () => {
    for (const status of ['submitted', 'no_go', 'cancelled']) {
      const { member, base } = await setup({ status, closed_at: new Date() });
      const api = await as(member);
      const res = await api.post(base).send({ text: 'Ανασκόπηση μετά την κατάθεση', changes_template: true });
      expect(res.status).toBe(201);
      expect((await api.patch(`${base}/${res.body.id}`).send({ category: 'near_miss' })).status).toBe(200);
      expect((await api.delete(`${base}/${res.body.id}`)).status).toBe(204);
    }
  });

  it('authors change their own lessons; bid manager and admin change any; others cannot', async () => {
    const { org, admin, manager, member, tender, base } = await setup();
    const other = await createUser(org, 'member');
    const approver = await createUser(org, 'approver');
    const viewer = await createUser(org, 'viewer');
    const outsider = await createUser(org, 'member');
    for (const u of [other, approver, viewer]) await addMember(tender, u);

    const mine = (await as(member).post(base).send({ text: 'Δικό μου' })).body;
    expect((await as(member).patch(`${base}/${mine.id}`).send({ text: 'Δικό μου, διορθωμένο' })).body.text).toBe('Δικό μου, διορθωμένο');

    for (const u of [other, approver]) {
      const api = await as(u);
      expect((await api.get(base)).body.items[0].id).toBe(mine.id);
      const p = await api.patch(`${base}/${mine.id}`).send({ text: 'x' });
      expect([p.status, p.body.error.code]).toEqual([403, 'lesson_not_yours']);
      expect((await api.delete(`${base}/${mine.id}`)).status).toBe(403);
      expect((await api.post(base).send({ text: `Από ${u.org_role}` })).status).toBe(201);
    }
    // viewer: read-only; a non-member of the tender: nothing at all
    const v = await as(viewer);
    expect((await v.get(base)).status).toBe(200);
    expect((await v.post(base).send({ text: 'x' })).status).toBe(403);
    expect((await v.patch(`${base}/${mine.id}`).send({ text: 'x' })).status).toBe(403);
    expect((await v.delete(`${base}/${mine.id}`)).status).toBe(403);
    const o = await as(outsider);
    expect((await o.get(base)).status).toBe(403);
    expect((await o.post(base).send({ text: 'x' })).status).toBe(403);

    expect((await as(manager).patch(`${base}/${mine.id}`).send({ changes_template: true })).body.changes_template).toBe(true);
    expect((await as(admin).patch(`${base}/${mine.id}`).send({ category: 'other' })).body.category).toBe('other');
    expect((await as(manager).delete(`${base}/${mine.id}`)).status).toBe(204);
    expect((await as(admin).delete(`${base}/${mine.id}`)).status).toBe(404);
    expect((await as(admin).patch(`${base}/not-a-uuid`).send({ text: 'x' })).status).toBe(404);
    expect(await dbFor(org).count('lesson', { tender_id: tender.id })).toBe(2);
  });

  it('a lesson is addressed through its own tender only', async () => {
    const { org, admin, base } = await setup();
    const lesson = (await as(admin).post(base).send({ text: 'x', changes_template: true })).body;
    const otherTender = await createTender(org);
    const wrong = `/api/tenders/${otherTender.id}/lessons/${lesson.id}`;
    const api = await as(admin);
    expect((await api.patch(wrong).send({ text: 'y' })).status).toBe(404);
    expect((await api.delete(wrong)).status).toBe(404);
    expect((await api.post(`${wrong}/apply`).send({ template_id: missingId() })).status).toBe(404);
  });

  it('pending lessons across tenders → admin marks them applied in a template version', async () => {
    const { org, admin, manager, member, tender, base } = await setup({ title: 'Διαγωνισμός Α' });
    const v11 = await template(org, '1.1');
    await dbFor(org).update('tender', tender.id, { template_id: v11.id, template_version: '1.1' });
    const tenderB = await createTender(org, { title: 'Διαγωνισμός Β', status: 'submitted' });

    const flagged = (await as(member).post(base).send({ text: 'Νέα γραμμή checklist: ΥΔ εταίρων', changes_template: true })).body;
    const note = (await as(member).post(base).send({ text: 'Απλή σημείωση' })).body;
    const flaggedB = (await as(manager).post(`/api/tenders/${tenderB.id}/lessons`).send({ text: 'Το G3 θέλει T−6', category: 'delay', changes_template: true })).body;

    const api = await as(admin);
    const pending = await api.get('/api/templates/lessons/pending');
    expect(pending.status).toBe(200);
    expect(pending.body.items.map((l: { id: string }) => l.id)).toEqual([flagged.id, flaggedB.id]);
    expect(pending.body.items[0]).toMatchObject({
      tender_id: tender.id,
      tender_title: 'Διαγωνισμός Α',
      tender_status: 'in_progress',
      tender_template_id: v11.id,
      tender_template_name: 'L',
      tender_template_version: '1.1',
      created_by_name: 'Μέλος Α',
    });
    expect(pending.body.items[1]).toMatchObject({ tender_title: 'Διαγωνισμός Β', tender_status: 'submitted', tender_template_version: null });

    // only an admin applies; the lesson must be flagged; the template must exist
    const v12 = await template(org, '1.2', 'draft');
    expect((await as(manager).post(`${base}/${flagged.id}/apply`).send({ template_id: v12.id })).status).toBe(403);
    expect((await as(member).post(`${base}/${flagged.id}/apply`).send({ template_id: v12.id })).status).toBe(403);
    const notFlagged = await api.post(`${base}/${note.id}/apply`).send({ template_id: v12.id });
    expect([notFlagged.status, notFlagged.body.error.code]).toEqual([422, 'lesson_not_flagged']);
    const noTemplate = await api.post(`${base}/${flagged.id}/apply`).send({ template_id: missingId() });
    expect([noTemplate.status, noTemplate.body.error.code]).toEqual([404, 'template_not_found']);
    expect((await api.post(`${base}/${flagged.id}/apply`).send({})).status).toBe(400);

    const applied = await api.post(`${base}/${flagged.id}/apply`).send({ template_id: v12.id });
    expect(applied.status).toBe(200);
    expect(applied.body).toMatchObject({ id: flagged.id, applied_in_version: '1.2', applied_template_id: v12.id });
    expect((await api.get('/api/templates/lessons/pending')).body.items.map((l: { id: string }) => l.id)).toEqual([flaggedB.id]);
    expect((await api.get(`/api/templates/${v12.id}/lessons`)).body.items.map((l: { id: string }) => l.id)).toEqual([flagged.id]);
    expect((await as(member).get(base)).body.items[0]).toMatchObject({ applied_in_version: '1.2' });
    expect(await dbFor(org).findOne('audit_log', { entity: 'lesson', entity_id: flagged.id, action: 'update' })).toMatchObject({ user_id: admin.id });

    // an applied lesson cannot lose its flag; undo makes it pending again
    const unflag = await as(manager).patch(`${base}/${flagged.id}`).send({ changes_template: false });
    expect([unflag.status, unflag.body.error.code]).toEqual([422, 'lesson_already_applied']);
    expect((await as(manager).delete(`${base}/${flagged.id}/apply`)).status).toBe(403);
    expect((await api.delete(`${base}/${flagged.id}/apply`)).body).toMatchObject({ applied_in_version: null, applied_template_id: null });
    expect((await api.get('/api/templates/lessons/pending')).body.items).toHaveLength(2);
  });

  it('another organization never sees, changes or applies a lesson', async () => {
    const { org, admin, tender, base } = await setup();
    const lesson = (await as(admin).post(base).send({ text: 'Μυστικό', changes_template: true })).body;
    const foreignOrg = await createOrg();
    const foreign = await as(await createUser(foreignOrg, 'admin'));
    const foreignTemplate = await template(foreignOrg, '1.0');
    const foreignTender = await createTender(foreignOrg);

    expect((await foreign.get(base)).status).toBe(404);
    expect((await foreign.post(base).send({ text: 'x' })).status).toBe(404);
    expect((await foreign.patch(`${base}/${lesson.id}`).send({ text: 'x' })).status).toBe(404);
    expect((await foreign.delete(`${base}/${lesson.id}`)).status).toBe(404);
    expect((await foreign.post(`${base}/${lesson.id}/apply`).send({ template_id: foreignTemplate.id })).status).toBe(404);
    // through the foreign org's own tender the lesson does not exist either
    const own = `/api/tenders/${foreignTender.id}/lessons/${lesson.id}`;
    expect((await foreign.patch(own).send({ text: 'x' })).status).toBe(404);
    expect((await foreign.post(`${own}/apply`).send({ template_id: foreignTemplate.id })).status).toBe(404);
    expect((await foreign.get('/api/templates/lessons/pending')).body.items).toEqual([]);
    expect((await foreign.get(`/api/templates/${foreignTemplate.id}/lessons`)).body.items).toEqual([]);

    // and a lesson cannot be applied to another organization's template
    const cross = await as(admin).post(`${base}/${lesson.id}/apply`).send({ template_id: foreignTemplate.id });
    expect([cross.status, cross.body.error.code]).toEqual([404, 'template_not_found']);
    expect(await dbFor(org).get('lesson', lesson.id)).toMatchObject({ text: 'Μυστικό', applied_template_id: null, tender_id: tender.id });
  });
});
