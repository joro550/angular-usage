import { Component, inject } from '@angular/core';
import { StateService } from './services/state.service';
import { UploadComponent } from './upload/upload.component';
import { OverviewComponent } from './overview/overview.component';
import { ComponentDetailComponent } from './component-detail/component-detail.component';
import { FunctionDetailComponent } from './function-detail/function-detail.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    UploadComponent,
    OverviewComponent,
    ComponentDetailComponent,
    FunctionDetailComponent,
  ],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  readonly state = inject(StateService);
}
