import {
  canAdmin,
  canEdit,
  canViewVisibility,
  effectivePermission,
  hasCapability,
} from './money-space.utils';

describe('authorization helpers', () => {
  describe('effectivePermission', () => {
    it('derives from role when no override', () => {
      expect(effectivePermission('owner')).toBe('admin');
      expect(effectivePermission('partner')).toBe('edit_content');
      expect(effectivePermission('viewer')).toBe('view_summary');
    });
    it('uses the override when set', () => {
      expect(effectivePermission('viewer', 'edit_content')).toBe(
        'edit_content',
      );
    });
  });

  describe('canEdit / canAdmin', () => {
    it('owner (admin) can edit and admin', () => {
      expect(canEdit('admin')).toBe(true);
      expect(canAdmin('admin')).toBe(true);
    });
    it('partner (edit_content) can edit but not admin', () => {
      expect(canEdit('edit_content')).toBe(true);
      expect(canAdmin('edit_content')).toBe(false);
    });
    it('viewer (view_summary) can neither', () => {
      expect(canEdit('view_summary')).toBe(false);
      expect(canAdmin('view_summary')).toBe(false);
    });
  });

  describe('hasCapability', () => {
    it('any permission has view', () => {
      expect(hasCapability('view_summary', 'view')).toBe(true);
    });
    it('edit requires edit_content+', () => {
      expect(hasCapability('view_detail', 'edit')).toBe(false);
      expect(hasCapability('edit_content', 'edit')).toBe(true);
    });
    it('admin requires admin', () => {
      expect(hasCapability('edit_content', 'admin')).toBe(false);
      expect(hasCapability('admin', 'admin')).toBe(true);
    });
  });

  describe('canViewVisibility', () => {
    it('summary viewer sees summary_only but not detail', () => {
      expect(canViewVisibility('view_summary', 'summary_only')).toBe(true);
      expect(canViewVisibility('view_summary', 'grouped')).toBe(false);
      expect(canViewVisibility('view_summary', 'detail')).toBe(false);
    });
    it('grouped viewer sees up to grouped', () => {
      expect(canViewVisibility('view_grouped', 'grouped')).toBe(true);
      expect(canViewVisibility('view_grouped', 'detail')).toBe(false);
    });
    it('detail+ viewer sees detail', () => {
      expect(canViewVisibility('view_detail', 'detail')).toBe(true);
      expect(canViewVisibility('edit_content', 'detail')).toBe(true);
    });
    it('private is creator/admin only', () => {
      expect(canViewVisibility('edit_content', 'private')).toBe(false);
      expect(
        canViewVisibility('edit_content', 'private', { isCreator: true }),
      ).toBe(true);
      expect(canViewVisibility('admin', 'private')).toBe(true);
    });
  });
});
