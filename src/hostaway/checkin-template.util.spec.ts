import {
  htmlToPlainText,
  pickCheckinTemplate,
  scoreCheckinTemplate,
} from './checkin-template.util';

describe('checkin-template.util', () => {
  it('converts simple HTML to plain text', () => {
    expect(htmlToPlainText('<p>Hi</p><br>Adresse: Test')).toContain('Adresse');
    expect(htmlToPlainText('A<br/>B')).toBe('A\nB');
  });

  it('prefers listing-specific Anreiseinfo templates', () => {
    const picked = pickCheckinTemplate(
      [
        {
          id: 1,
          name: 'Angebot mit Buchungslink',
          message: 'Angebot für {{listing_name}}',
          listingMapId: null,
        },
        {
          id: 2,
          name: 'Anreiseinfo Seedomizil',
          message: 'Hi! Adresse und Zugang …',
          listingMapId: 172758,
        },
        {
          id: 3,
          name: 'Anreiseinfo schoenermieten',
          message: 'Hi der Code {{door_code}}',
          listingMapId: null,
        },
      ],
      172758,
    );

    expect(picked?.id).toBe(2);
    expect(scoreCheckinTemplate(picked!, 172758)).toBeGreaterThan(100);
  });

  it('returns null when nothing looks like check-in info', () => {
    expect(
      pickCheckinTemplate(
        [
          {
            id: 9,
            name: 'Quote',
            message: 'Thank you for your interest',
          },
        ],
        1,
      ),
    ).toBeNull();
  });
});
